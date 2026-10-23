import { createServer } from 'node:http';
import { Readable } from 'node:stream';

export function promptUpperBound(payload, previous) {
  const serialized = JSON.stringify({messages:payload.messages,tools:payload.tools,tool_choice:payload.tool_choice});
  let upper = Buffer.byteLength(serialized) + 1024;
  if (previous?.input != null) {
    let common = 0;
    while(common < serialized.length && common < previous.serialized.length && serialized[common] === previous.serialized[common]) common++;
    upper = Math.min(upper,previous.input + Buffer.byteLength(serialized.slice(common)) + 1024);
  }
  return {serialized,upper};
}

/** A single-case gateway measures actual provider usage, caps output and bounds admission. */
export async function startGateway(model,budget,record) {
  const state={input:0,output:0,requests:0,unknown_usage:0,blocked:null,previous:null,deadline:Date.now()+budget.seconds*1000};
  // SDK completion can precede upstream HTTP EOF. Admit the next request only
  // after the previous response's final usage has been reconciled.
  let admission=Promise.resolve();
  const server=createServer(async(req,res)=>{
    const previousAdmission=admission;let release;
    admission=new Promise(resolve=>{release=resolve;});
    await previousAdmission;
    let activeRequest=null;
    try {
      if(req.method!=='POST'||!req.url.endsWith('/chat/completions')) {res.writeHead(404).end();return;}
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const payload=JSON.parse(Buffer.concat(chunks).toString());
      const bound=promptUpperBound(payload,state.previous);
      const reason=Date.now()>=state.deadline?'wall_clock':state.unknown_usage?'unknown_usage':
        state.input+bound.upper>budget.input?'input_admission_guard':state.output>=budget.output?'output_tokens':null;
      if(reason){state.blocked=reason;record({type:'budget_block',reason,input:state.input,output:state.output,input_upper_bound:bound.upper});
        res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:`M6_BUDGET_STOP:${reason}`,type:'budget_limit'}}));return;}
      payload.max_tokens=Math.min(Number(payload.max_tokens??payload.max_completion_tokens??budget.request_output),budget.request_output,budget.output-state.output);
      if(payload.max_completion_tokens!==undefined){payload.max_completion_tokens=payload.max_tokens;delete payload.max_tokens;}
      const number=++state.requests,started=Date.now();
      activeRequest={number,started};
      record({type:'request_start',number,input_upper_bound:bound.upper,max_output:payload.max_tokens??payload.max_completion_tokens});
      const upstream=await fetch(model.base_url.replace(/\/$/,'')+'/chat/completions',{
        method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${model.api_key}`},body:JSON.stringify(payload),
        signal:AbortSignal.timeout(Math.max(1,state.deadline-Date.now()))});
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});
      let tail='',usage=null;
      if(upstream.body)for await(const chunk of Readable.fromWeb(upstream.body)){
        res.write(chunk);tail+=Buffer.from(chunk).toString('utf8');
        if(payload.stream){const lines=tail.split('\n');tail=lines.pop()??'';for(const line of lines){
          if(!line.startsWith('data:'))continue;try{const data=JSON.parse(line.slice(5).trim());if(data.usage)usage=data.usage;}catch{}}}
      }
      if(!payload.stream)try{usage=JSON.parse(tail).usage??null;}catch{}
      const input=usage?.prompt_tokens??usage?.input_tokens,output=usage?.completion_tokens??usage?.output_tokens;
      const known=Number.isSafeInteger(input)&&input>=0&&Number.isSafeInteger(output)&&output>=0;
      if(known){
        state.input+=input;state.output+=output;state.previous={serialized:bound.serialized,input};
      }else state.unknown_usage++;
      record({type:'request_end',number,status:upstream.status,elapsed_ms:Date.now()-started,input:known?input:null,output:known?output:null,
        cache_read:usage?.prompt_tokens_details?.cached_tokens??usage?.prompt_cache_hit_tokens??null});
      res.end();
    }catch(error){
      if(activeRequest){
        state.unknown_usage++;
        record({type:'request_end',number:activeRequest.number,status:null,elapsed_ms:Date.now()-activeRequest.started,input:null,output:null});
      }
      record({type:'gateway_error',name:error.name});if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'M6 gateway transport failure',type:'transport_error'}}));}
    finally{release();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(19081,'127.0.0.1',resolve);});
  return {server,state,base_url:'http://127.0.0.1:19081/v1'};
}
