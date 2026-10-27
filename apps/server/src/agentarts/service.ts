import { PrismaClient } from '@prisma/client';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { requestSchema, today, validatePlan } from './contract';
import { invokeRuntime, RunEvent } from './runtime';
import { invokeDeepSeek, planningProvider } from './deepseek';

type Source={id:string;title:string;text:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export class AgentService {
  constructor(private db:PrismaClient, private invoke?:typeof invokeRuntime){}
  async get(userId:string,id:string){
    const run=await this.db.agentRun.findFirst({where:{id,userId}});if(!run)throw new Error('运行记录不存在');
    const {toolTokenHash,expiresAt,...safe}=run;
    return {...safe,sources:JSON.parse(run.sources),events:JSON.parse(run.events),result:run.result?JSON.parse(run.result):null};
  }
  async list(userId:string){return this.db.agentRun.findMany({where:{userId},select:{id:true,goal:true,status:true,mode:true,createdAt:true},orderBy:{createdAt:'desc'},take:30});}
  async run(userId:string,value:unknown){
    const input=requestSchema.parse(value);const startDate=today();
    if(input.examDate<startDate||Date.parse(input.examDate)-Date.parse(startDate)>90*86400000)throw new Error('考试日期须在今天到90天内');
    const course=await this.db.course.findFirst({where:{id:input.courseId,userId},include:{knowledgeNodes:true}});if(!course)throw new Error('课程不存在');
    const nodes=course.knowledgeNodes.slice(0,80);
    const notes=await this.db.note.findMany({where:{userId},orderBy:{updatedAt:'desc'},take:100});
    const related=notes.filter(n=>JSON.parse(n.relatedNodeIds).some((id:string)=>nodes.some(k=>k.id===id)) || n.title.includes(course.name));
    const sources:Source[]=[...nodes.map(n=>({id:'kg:'+n.id,title:n.name,text:n.description.slice(0,1800)})),...related.slice(0,20).map(n=>({id:'note:'+n.id,title:n.title,text:n.content.slice(0,1800)}))];
    if(!sources.length)throw new Error('请先为课程添加知识点或关联笔记，计划必须有真实资料依据');
    const token=randomBytes(32).toString('hex');
    const run=await this.db.agentRun.create({data:{userId,...input,startDate,sources:JSON.stringify(sources.map(({id,title})=>({id,title}))),toolTokenHash:hash(token),expiresAt:new Date(Date.now()+120_000)}});
    const events:RunEvent[]=[];
    try{
      const onEvent=(e:RunEvent)=>{if(events.length<200)events.push(e);};
      const raw=this.invoke
        ? await this.invoke({...input,startDate,courseName:course.name,runId:run.id,toolToken:token},run.id,onEvent)
        : planningProvider()==='DeepSeek'
          ? await invokeDeepSeek({...input,startDate,courseName:course.name},await this.tool(run.id,token,input.goal),onEvent)
          : await invokeRuntime({...input,startDate,courseName:course.name,runId:run.id,toolToken:token},run.id,onEvent);
      const clean=raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
      const stored=await this.db.agentRun.findUniqueOrThrow({where:{id:run.id}});
      const retrieved=JSON.parse(stored.events).filter((e:any)=>e.status==='sources_retrieved');
      const sourceIds=retrieved.flatMap((e:any)=>e.sourceIds||[]) as string[];
      const plan=validatePlan(JSON.parse(clean),{startDate,examDate:input.examDate,dailyMinutes:input.dailyMinutes,sourceIds});
      await this.db.agentRun.update({where:{id:run.id},data:{status:'SUCCEEDED',result:JSON.stringify(plan),events:JSON.stringify([...retrieved,...events])}});
    }catch(error){
      const message=error instanceof Error?error.message:'运行失败';
      await this.db.agentRun.update({where:{id:run.id},data:{status:'FAILED',error:message.slice(0,500),events:JSON.stringify(events)}});
    }
    return this.get(userId,run.id);
  }
  async confirm(userId:string,id:string){
    return this.db.$transaction(async tx=>{
      const run=await tx.agentRun.findFirst({where:{id,userId}});if(!run)throw new Error('运行记录不存在');
      if(run.status==='CONFIRMED')return {message:'该计划已确认，不重复创建任务'};
      if(run.status!=='SUCCEEDED')throw new Error('仅成功计划可确认');
      const course=await tx.course.findFirst({where:{id:run.courseId,userId}});if(!course)throw new Error('课程已不存在');
      const plan=validatePlan(JSON.parse(run.result),{...run,sourceIds:JSON.parse(run.events).filter((e:any)=>e.status==='sources_retrieved').flatMap((e:any)=>e.sourceIds||[])});
      if(plan.tasks.some(t=>t.date<today()))throw new Error('计划已过期，请重新生成');
      const claimed=await tx.agentRun.updateMany({where:{id,userId,status:'SUCCEEDED'},data:{status:'CONFIRMED'}});if(!claimed.count)throw new Error('计划已由其他请求确认');
      for(const item of plan.tasks)await tx.task.create({data:{userId,courseId:run.courseId,title:item.title,description:item.description+'\n依据：'+item.sourceIds.join(', '),type:'STUDY',priority:3,estimatedMinutes:item.minutes,scheduledAt:new Date(item.date+'T09:00:00+08:00')}});
      return {message:'已创建学习任务',count:plan.tasks.length};
    });
  }
  async tool(runId:string,token:string,query:string){
    const run=await this.db.agentRun.findUnique({where:{id:runId}});
    if(!run||run.status!=='RUNNING'||run.expiresAt<new Date()||!timingSafeEqual(Buffer.from(run.toolTokenHash),Buffer.from(hash(token))))throw new Error('运行工具授权无效');
    const course=await this.db.course.findFirst({where:{id:run.courseId,userId:run.userId},include:{knowledgeNodes:true}});if(!course)throw new Error('课程不存在');
    const available=JSON.parse(run.sources) as {id:string;title:string}[];
    const notes=await this.db.note.findMany({where:{userId:run.userId,id:{in:available.filter(s=>s.id.startsWith('note:')).map(s=>s.id.slice(5))}}});
    const candidates:Source[]=[...course.knowledgeNodes.map(n=>({id:'kg:'+n.id,title:n.name,text:n.description.slice(0,1800)})),...notes.map(n=>({id:'note:'+n.id,title:n.title,text:n.content.slice(0,1800)}))].filter(s=>available.some(a=>a.id===s.id));
    const terms=Array.from(new Set(query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/g)||[]));
    const ranked=candidates.map(s=>({s,score:terms.filter(t=>(s.title+s.text).toLowerCase().includes(t)).length})).sort((a,b)=>b.score-a.score).slice(0,8).map(v=>v.s);
    const tasks=await this.db.task.findMany({where:{userId:run.userId,courseId:run.courseId},select:{title:true,status:true,estimatedMinutes:true,actualMinutes:true,scheduledAt:true},take:100});
    await this.db.$transaction(async tx=>{
      const current=await tx.agentRun.findUniqueOrThrow({where:{id:runId}});
      if(current.status!=='RUNNING'||current.expiresAt<new Date())throw new Error('运行工具授权已失效');
      const audit=JSON.parse(current.events);
      if(audit.length>=100)throw new Error('工具调用次数超过限制');
      audit.push({name:'课程资料检索',type:'knowledge',status:'sources_retrieved',at:new Date().toISOString(),sourceIds:ranked.map(s=>s.id)});
      await tx.agentRun.update({where:{id:runId},data:{events:JSON.stringify(audit)}});
    });
    return {course:{name:course.name,masteryLevel:course.masteryLevel},sources:ranked,tasks};
  }
}
