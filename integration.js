(function(){
  const generate=document.querySelector('#generate');
  if(!generate)return;
  window.atelierRefs=[];
  document.querySelectorAll('input[type=file]').forEach(input=>input.addEventListener('change',()=>{const f=input.files?.[0];if(!f)return;const reader=new FileReader();reader.onload=()=>{window.atelierRefs.push({type:input.dataset.type||'reference',data:reader.result});};reader.readAsDataURL(f)}));
  function cfg(){return JSON.parse(localStorage.getItem('atelier-api')||'{}')}
  function imageFromResponse(data){
    const text=JSON.stringify(data);
    const b64=text.match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/);if(b64)return b64[0];
    const url=text.match(/https?:[^"\\ ]+\.(?:png|jpg|jpeg|webp)(?:\?[^"\\ ]*)?/i);if(url)return url[0];
    const markdown=JSON.stringify(data).match(/https?:[^"\\ ]+/);return markdown?markdown[0]:null;
  }
  generate.onclick=async()=>{
    const c=cfg();if(!c.endpoint||!c.key||!c.model){toast('请先在 API 配置中填写 Endpoint、模型和 Key');return}
    generate.disabled=true;generate.textContent='请求中…';
    try{
      const prompt=(document.querySelector('#prompt')?.value||'').trim()||'Create a high quality studio portrait photo.';
      const content=[{type:'text',text:prompt}];window.atelierRefs.slice(0,8).forEach(ref=>content.push({type:'image_url',image_url:{url:ref.data}}));
      const response=await fetch(c.endpoint.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+c.key},body:JSON.stringify({model:c.model,messages:[{role:'user',content}]})});
      const data=await response.json();if(!response.ok)throw new Error(data.error?.message||`HTTP ${response.status}`);
      const image=imageFromResponse(data);if(!image)throw new Error('接口返回成功，但没有识别到图片 URL 或 Base64');
      const gallery=document.querySelector('#gallery');gallery.innerHTML='';const card=document.createElement('div');card.className='result-card';card.style.backgroundImage=`url(${image})`;card.innerHTML='<button class="result-check">✓</button><span class="result-label">API 返回结果</span>';gallery.append(card);toast('图片生成成功');
    }catch(e){toast('生成失败：'+e.message)}finally{generate.disabled=false;generate.textContent='✦ 开始生成'}
  };
})();
