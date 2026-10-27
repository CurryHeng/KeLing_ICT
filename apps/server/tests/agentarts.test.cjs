require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan } = require('../src/agentarts/contract');
const { readRuntimeStream } = require('../src/agentarts/runtime');
const limits = { startDate: '2026-10-27', examDate: '2026-11-10', dailyMinutes: 60, sourceIds: ['kg:1'] };
const plan = () => ({ summary: '学习计划', tasks: [{ title: '二叉树练习', description: '完成遍历题', date: '2026-10-28', minutes: 30, sourceIds: ['kg:1'] }] });
test('rejects empty, impossible date, excess time and invented source', () => {
  assert.throws(() => validatePlan({ summary:'x', tasks: [] }, limits));
  for (const patch of [{date:'2026-02-30'}, {minutes:61}, {sourceIds:['unknown']}, {date:'2026-11-11'}]) {
    const value=plan(); Object.assign(value.tasks[0],patch); assert.throws(() => validatePlan(value,limits));
  }
  assert.equal(validatePlan(plan(),limits).tasks[0].minutes,30);
});
test('enforces combined daily budget', () => {
  const value=plan(); value.tasks.push({...value.tasks[0],minutes:40}); assert.throws(() => validatePlan(value,limits));
});
test('parses SSE across byte boundaries and ignores reasoning', async () => {
  const s='data: '+JSON.stringify({event:'summary_response',content:JSON.stringify(plan()),reasoning_content:'private'})+'\r\n\r\ndata: {"event":"end"}\n\n';
  const bytes=Buffer.from(s); const stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.subarray(i,i+7));c.close();}});
  const events=[]; const result=await readRuntimeStream(stream,e=>events.push(e));
  assert.equal(JSON.parse(result).summary,'学习计划'); assert.ok(!JSON.stringify(events).includes('private'));
});
test('does not accept a failed or truncated runtime as success', async () => {
  for (const s of ['data: {"event":"error","data":{"message":"fail"}}\n\n','data: {"event":"message","content":"partial"}\n\n']) {
    await assert.rejects(()=>readRuntimeStream(new Response(s).body,()=>{}));
  }
});
