import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {Campaign} from '../src/domain/campaign.ts';
import {Session} from '../src/domain/session.ts';
import {StoryDirector,type StoryUI} from '../src/domain/story-director.ts';

const campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')) as Campaign;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(popup:StoryUI['questPopup']) {
  const content={...campaign,events:[]},session=new Session(content),actions:string[]=[];let flushes=0;
  const ui:StoryUI={async dialogue(){},async choice(){throw new Error('unexpected choice');},questPopup:popup,
    closeDialogue(){},skipDialogue(){},toast(){}};
  const director=new StoryDirector(content,session,ui,()=>{},{begin(){},async execute(action){actions.push(action.type==='leave'?'leave:'+action.target:action.type);},async finish(){},async flushStage(){flushes++;}});
  return {session,director,actions,flushes:()=>flushes};
}

test('native quest state commands commit before their popup and same-state guards bypass both',()=>{
  let journaled=0,journalExternal=0;
  for(const [name,script] of Object.entries(campaign.scripts)) {
    if(!/^event-\d+$/.test(name))continue;
    for(const node of script.nodes)for(const command of node.commands) {
      if(command.type!=='quest'||!['accept','script-complete'].includes(command.command.type))continue;
      if(!('quest' in command.command))continue;
      const questId=command.command.quest;
      const quest=campaign.quests.find(quest=>quest.id===questId)!;
      assert.ok(quest,`${name}/${node.id}`);
      assert.ok(node.exit.type==='next');
      const next=script.nodes.find(candidate=>candidate.id===(node.exit.type==='next'?node.exit.target.node:''))!;
      const popup=next.presentation.find(action=>action.type==='quest-popup'&&action.quest===quest.id);
      if(quest.journal===false){journalExternal++;assert.equal(popup,undefined,`${name}/${quest.id}`);continue;}
      journaled++;
      assert.deepEqual(popup,{type:'quest-popup',kind:command.command.type==='accept'?'start':'complete',quest:quest.id});
      assert.deepEqual(next.commands,[],'confirming the popup cannot commit the reward again');
      assert.ok(next.exit.type==='next');
      assert.ok(script.nodes.some(guard=>guard.exit.type==='branch'&&guard.exit.otherwise.node===node.id
        &&guard.exit.then.node===(next.exit.type==='next'?next.exit.target.node:'')),`${name}/${quest.id}: missing same-state guard`);
    }
  }
  assert.ok(journaled>0);assert.ok(journalExternal>0);
});

test('the original forest quest popup observes committed acceptance and direct replay grants nothing twice',async()=>{
  const popups:string[]=[];
  const h=harness(async(kind,quest)=>{
    popups.push(`${kind}:${quest.id}`);
    assert.equal(h.flushes(),1,'任务窗出现前先补画剧情舞台');
    assert.equal(h.session.questBook.accepted(quest.id),true);
    assert.ok(h.actions.includes('leave:darius'),'Darius departs before the quest is announced');
  });
  await h.director.script('event-1');
  assert.deepEqual(popups,['start:grafton-mission']);
  const before=h.session.questBook.captureState();
  await h.director.script('event-1');
  assert.deepEqual(popups,['start:grafton-mission']);
  assert.deepEqual(h.session.questBook.captureState(),before);
});

test('journal-external quests settle through dialogue without opening a panel',async()=>{
  const popups:string[]=[];
  const h=harness(async(kind,quest)=>{popups.push(`${kind}:${quest.id}`);});
  assert.equal(h.session.accept('quest-61'),true);
  assert.equal(h.session.status('quest-61'),'ready');
  const entity={id:'barricade-221',actor:'barricade-221',characterId:'npc-221',x:88,y:408};
  const actor={id:'barricade-221',name:'路障'};
  await h.director.interact(entity as never,actor as never);
  assert.equal(h.session.status('quest-61'),'completed');
  assert.deepEqual(popups,[],'日志外任务交付不弹面板');
});

test('cancelling a native completion popup keeps its reward and retry only confirms the settled quest',async()=>{
  let pending=false,confirm=false,completionPopups=0;
  const h=harness(async(kind,quest,reward,signal)=>{
    if(kind!=='complete'||quest.id!=='quest-24')return;
    completionPopups++;
    assert.equal(h.session.status(quest.id),'completed');
    assert.deepEqual(reward,h.session.rewardReceiptFor(quest.id));
    assert.ok(reward);
    pending=true;
    if(!confirm)await new Promise<void>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));
  });
  const run=h.director.script('event-22');
  for(let count=0;count<30&&!pending;count++)await tick();
  assert.equal(pending,true);assert.equal(h.director.canSkip,false);
  const receipt=h.session.rewardReceiptFor('quest-24');
  h.director.cancel();await run;
  assert.equal(h.session.status('quest-24'),'completed');
  assert.deepEqual(h.session.rewardReceiptFor('quest-24'),receipt);
  confirm=true;assert.equal(await h.director.retry(),true);
  assert.equal(completionPopups,2);
  assert.deepEqual(h.session.rewardReceiptFor('quest-24'),receipt);
  assert.equal(h.session.captureState().receipts.filter(receipt=>receipt.quest==='quest-24').length,1);
  await h.director.script('event-22');
  assert.equal(completionPopups,2);
  assert.equal(h.session.captureState().receipts.filter(receipt=>receipt.quest==='quest-24').length,1);
});
