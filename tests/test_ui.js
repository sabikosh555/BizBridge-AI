// Regression checks for user-visible progress and draft recovery, no browser packages.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
function harness() {
  const storage = new Map();
  const ctx = vm.createContext({
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    document:{addEventListener(){},querySelector(){return null;}},
    fetch:()=>new Promise(()=>{}),setTimeout,clearTimeout,console
  });
  vm.runInContext(fs.readFileSync('static/app.js','utf8')+`
    globalThis.testing={
      setup(value){state=value;},progress:teamProgressCard,read:readEditor,
      save(value,step){editor=value;editorStep=step;saveEditor();}
    };`,ctx);
  return {ui:ctx.testing,storage};
}
const base={teams:[{id:'u1',name:'Test Team'}],proposals:[{id:'p1',team_id:'u1',status:'selected'}],milestones:[],topics:['Ритейл'],labels:{title:'Название',context:'Контекст'}};
for(const [points,remaining] of [[0,50],[20,30],[60,40]]){
  test(`team with ${points} confirmed XP has ${remaining} to next level`,()=>{
    const {ui}=harness();ui.setup({...base,milestones:[{proposal_id:'p1',status:'confirmed',points},{proposal_id:'p1',status:'pending',points:1000}]});
    const html=ui.progress('u1');assert.match(html,new RegExp(`<strong>${points}</strong>`));assert.ok(html.includes(`${remaining} XP до следующего уровня`));
  });
}
test('maximum level does not promise a nonexistent next level',()=>{
 const {ui}=harness();ui.setup({...base,milestones:[{proposal_id:'p1',status:'confirmed',points:220}]});assert.ok(ui.progress('u1').includes('Максимальный уровень'));
});
test('draft recovery preserves answers but never confirmation',()=>{
 const {ui}=harness();ui.setup(base);ui.save({topic:'Ритейл',fields:{title:'Кофейня',context:'Описание задачи'},questions:[],confirmNow:true},3);
 const restored=ui.read();assert.equal(restored.editor.fields.context,'Описание задачи');assert.equal(restored.step,3);assert.equal(restored.editor.confirmNow,false);
});
test('broken storage does not crash or recover unsafe data',()=>{
 const {ui,storage}=harness();ui.setup(base);
 for(const value of ['{','null',JSON.stringify({step:3,editor:{topic:'Ритейл',fields:{},questions:[]}})]){
   storage.set('sana-editor-draft-v1',value);assert.equal(ui.read(),null);
 }
});
