import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import './Agent.css';

interface Course {id:string;name:string}
interface RunSummary {id:string;goal:string;status:string;mode:string;createdAt:string}
interface Run extends RunSummary {error:string;events:{name:string;type:string;status:string;at:string}[];sources:{id:string;title:string}[];result:null|{summary:string;tasks:{title:string;description:string;date:string;minutes:number;sourceIds:string[]}[]}}
const labels:Record<string,string>={RUNNING:'运行中',FAILED:'运行失败',SUCCEEDED:'待确认',CONFIRMED:'已写入任务'};
export default function Agent(){
 const navigate=useNavigate(); const [courses,setCourses]=useState<Course[]>([]);const [history,setHistory]=useState<RunSummary[]>([]);const [run,setRun]=useState<Run|null>(null);
 const [courseId,setCourse]=useState('');const [goal,setGoal]=useState('');const [date,setDate]=useState('');const [minutes,setMinutes]=useState(60);const [mode,setMode]=useState('plan');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [configured,setConfigured]=useState<boolean|null>(null);const [provider,setProvider]=useState('AI');
 const refresh=async()=>{const {data}=await api.get('/agent/runs');setHistory(data.runs);};
 useEffect(()=>{Promise.all([api.get('/courses'),api.get('/agent/status'),api.get('/agent/runs')]).then(([c,s,h])=>{setCourses(c.data.courses);setConfigured(s.data.configured);setProvider(s.data.provider||'AI');setHistory(h.data.runs);}).catch(()=>setError('无法加载课程或运行记录，请检查后端连接'));},[]);
 const message=(e:unknown)=>{const v=e as {response?:{data?:{error?:string}}};return v.response?.data?.error||'请求失败，请检查后端和模型服务连接';};
 const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError('');setRun(null);try{const {data}=await api.post('/agent/runs',{courseId,goal,examDate:date,dailyMinutes:minutes,mode},{timeout:110000});setRun(data);await refresh();}catch(e){setError(message(e));}finally{setBusy(false);}};
 const confirm=async()=>{if(!run)return;setBusy(true);setError('');try{await api.post(`/agent/runs/${run.id}/confirm`);const {data}=await api.get(`/agent/runs/${run.id}`);setRun(data);await refresh();}catch(e){setError(message(e));}finally{setBusy(false);}};
 return <div className="agent-page"><header><p className="agent-eyebrow">课灵 · 智学编排</p><h1>把学习目标变成行动</h1><p>知识检索 → 计划规划 → 确认执行 → 阶段复盘</p></header>
 {configured===false&&<p role="status" className="agent-notice">学习规划服务尚未配置。请在后端填写DeepSeek API Key或AgentArts运行时配置。</p>}
 {error&&<p role="alert" className="agent-error">{error}</p>}
 <div className="agent-columns"><section className="agent-panel"><h2>学习目标</h2><form onSubmit={submit}>
 <label>课程<select required value={courseId} onChange={e=>setCourse(e.target.value)}><option value="">请选择已添加知识点的课程</option>{courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
 <label>目标<textarea required minLength={2} maxLength={1200} value={goal} onChange={e=>setGoal(e.target.value)} placeholder="例如：两周内掌握二叉树遍历和图的最短路径"/></label>
 <div className="agent-row"><label>考试日期<input required type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>每天分钟<input type="number" min={10} max={480} value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></label></div>
 <label>工作流<select value={mode} onChange={e=>setMode(e.target.value)}><option value="plan">生成学习计划</option><option value="review">基于完成记录复盘并调整</option></select></label>
 <button className="agent-primary" disabled={busy||configured!==true}>{busy?'正在处理，请稍候…':'运行 '+provider}</button></form>
 <h2>运行历史</h2>{history.length===0?<p>还没有运行记录。</p>:history.map(h=><button className="agent-history" key={h.id} onClick={()=>api.get(`/agent/runs/${h.id}`).then(({data})=>setRun(data)).catch(e=>setError(message(e)))}>{h.goal}<small>{labels[h.status]||h.status} · {new Date(h.createdAt).toLocaleString('zh-CN')}</small></button>)}</section>
 <section className="agent-panel agent-result"><h2>计划与执行依据</h2>{busy&&!run&&<p role="status">学习规划服务正在执行。完成后可查看实际返回的节点轨迹；请勿重复提交。</p>}{!run&&!busy&&<p>提交目标后，这里展示真实运行结果。计划确认后才会创建学习任务。</p>}
 {run&&<><p><strong>{labels[run.status]||run.status}</strong></p>{run.error&&<p className="agent-error">{run.error}</p>}{run.result&&<><p className="agent-summary">{run.result.summary}</p><div className="agent-tasks">{run.result.tasks.map((t,i)=><article key={i}><span>{t.date} · {t.minutes} 分钟</span><h3>{t.title}</h3><p>{t.description}</p><small>依据：{t.sourceIds.map(id=>run.sources.find(s=>s.id===id)?.title||id).join('、')}</small></article>)}</div>{run.status==='SUCCEEDED'&&<button className="agent-primary" disabled={busy} onClick={confirm}>确认计划并写入任务</button>}{run.status==='CONFIRMED'&&<button className="agent-primary" onClick={()=>navigate('/tasks')}>查看学习任务</button>}</>}
 <h2>执行轨迹</h2>{run.events.length? <ol className="agent-trace">{run.events.map((e,i)=><li key={i}><strong>{e.name}</strong><small>{e.type} · {e.status} · {new Date(e.at).toLocaleTimeString('zh-CN')}</small></li>)}</ol>:<p>该次运行没有返回可显示的节点事件。</p>}</>}
 </section></div></div>;
}

