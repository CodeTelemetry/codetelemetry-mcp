import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidateProjectDirectory, parseCandidate, HistoryReadBudgetError, type SessionCandidate } from '../src/client/import/sources/files.ts';
const keep={prompts:false,toolDetails:false};
const promptLine=JSON.stringify({timestamp:'2026-10-03T12:00:00Z',type:'event_msg',payload:{type:'user_message',message:'synthetic prompt'}})+'\n';
function fixture(text:string, source:SessionCandidate['source']='codex') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ct-history-read-'));
 const file=path.join(root,'rollout-test.jsonl');fs.writeFileSync(file,text);
 const bytes=fs.statSync(file).size;
 return {root,c:{source,file,extraFiles:[],mtimeMs:0,bytes,fileSig:`${bytes}:0`} satisfies SessionCandidate};
}
const budget=(remainingBytes=1024*1024)=>({remainingBytes,deadline:Date.now()+5000});
test('project header matches parser identity across UTF-8 chunk boundaries',async()=>{
 const start='{"type":"session_meta","payload":{"pad":"';const mid='","cwd":"/work/';
 const {root,c}=fixture(start+'x'.repeat(4095-Buffer.byteLength(start+mid))+mid+'é雪"}}\n'+promptLine);
 try {const b=budget();assert.equal(candidateProjectDirectory(c,b),'/work/é雪');assert(b.remainingBytes<1024*1024);
 const parsed=await parseCandidate(c,keep);assert(parsed.ok);assert.equal(parsed.session?.cwd,'/work/é雪');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('unknown headers fall back to the parser and preserve later project evidence',async()=>{
 const {root,c}=fixture('x'.repeat(256*1024)+'\n'+JSON.stringify({type:'turn_context',payload:{cwd:'/work/later'}})+'\n'+promptLine);
 try {assert.equal(candidateProjectDirectory(c,budget()),null);const parsed=await parseCandidate(c,keep);
 assert(parsed.ok);assert.equal(parsed.session?.cwd,'/work/later');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Claude metadata uses its first cwd without treating Codex-shaped payloads as cwd',()=>{
 const {root,c}=fixture(JSON.stringify({type:'session_meta',payload:{cwd:'/wrong'}})+'\n'+JSON.stringify({cwd:'/work/claude'})+'\n','claude-code');
 try{assert.equal(candidateProjectDirectory(c,budget()),'/work/claude');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('metadata and full parsing enforce shared physical read and time budgets',async()=>{
 const {root,c}=fixture(JSON.stringify({type:'session_meta',payload:{cwd:'/work/project'}})+'\n');
 try {
 const small=budget(4);assert.throws(()=>candidateProjectDirectory(c,small),HistoryReadBudgetError);assert.equal(small.remainingBytes,0);
 const full=budget(10);await assert.rejects(parseCandidate(c,keep,{maxBytes:1024,deadline:full.deadline,budget:full}),HistoryReadBudgetError);
 assert.equal(full.remainingBytes,-1,'at most one overflow byte is read');
 assert.throws(()=>candidateProjectDirectory(c,{remainingBytes:1024,deadline:0}),/time bound/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
