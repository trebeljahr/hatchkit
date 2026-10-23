import {EmailMessage} from 'cloudflare:email';
import core from './worker-core.mjs';
function bindings(env) {
  return {...env,EMAIL:{send:async message=>{
    const raw=`From: Hatchkit Security <${env.MAIL_FROM}>\r\nTo: ${env.MAIL_TO}\r\nSubject: ${message.subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@trebeljahr.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message.text}`;
    await env.EMAIL.send(new EmailMessage(env.MAIL_FROM,env.MAIL_TO,raw));
  }}};
}
export default {
  fetch(request,env){return core.fetch(request,bindings(env));},
  scheduled(controller,env,ctx){return core.scheduled(controller,bindings(env),ctx);},
};
