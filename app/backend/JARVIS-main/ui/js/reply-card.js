/* Stream into the original-style right-hand card with a live typing caret. */
(function(){
  'use strict';
  const text=document.getElementById('reply-text'),question=document.getElementById('reply-question'),scroller=document.getElementById('reply-scroll');
  let target=[],shown=[],timer=null,pending=false;
  function render(){const nearBottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<36;text.textContent=shown.join('');if(nearBottom)scroller.scrollTop=scroller.scrollHeight;}
  function tick(){
    const remaining=target.length-shown.length;
    if(remaining<=0){clearInterval(timer);timer=null;return;}
    const count=Math.min(remaining,Math.max(1,Math.min(12,Math.ceil(remaining/90))));
    shown.push(...target.slice(shown.length,shown.length+count));render();
  }
  function begin(clearQuestion=false){
    if(timer)clearInterval(timer);timer=null;target=[];shown=[];pending=true;
    if(clearQuestion)question.textContent='';text.textContent='正在思考…';scroller.scrollTop=0;
  }
  function receive(value){
    const next=Array.from(String(value||'').slice(0,100000));
    if(!next.length)return;
    if(pending){pending=false;text.textContent='';}
    if(!shown.every((c,i)=>next[i]===c))shown=[];
    target=next;
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){shown=[...target];render();return;}
    if(!timer)timer=setInterval(tick,18);
  }
  window.addEventListener('jarvis-chat-question',e=>{question.textContent='你：'+String(e.detail||'');});
  window.addEventListener('jarvis-chat-start',()=>begin());
  window.addEventListener('jarvis-realtime-turn-start',()=>begin(true));
  window.addEventListener('jarvis-chat-delta',e=>receive(e.detail));
  window.addEventListener('jarvis-chat-done',e=>receive(e.detail));
  window.addEventListener('jarvis-voice-transcript',e=>{
    if(e.detail.role==='user')question.textContent='你：'+e.detail.text;
    else receive(e.detail.text);
  });
  window.ReplyCard={snapshot:()=>({text:text.textContent,target:target.join(''),question:question.textContent,typing:Boolean(timer)})};
})();
