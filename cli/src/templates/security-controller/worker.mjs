import {EmailMessage} from 'cloudflare:email';
import core from './worker-core.mjs';
import {rawMessage} from './mail-core.mjs';
function bindings(env) {
  return {...env,EMAIL:{send:async message=>{
    await env.EMAIL.send(new EmailMessage(env.MAIL_FROM,env.MAIL_TO,rawMessage({...message,from:env.MAIL_FROM,to:env.MAIL_TO})));
  }}};
}
export default {
  fetch(request,env){return core.fetch(request,bindings(env));},
  scheduled(controller,env,ctx){return core.scheduled(controller,bindings(env),ctx);},
};
