// Diagnostic comparison only: ephemeral anonymous creds, no pairing request or QR output.
import makeWASocket, { Browsers, initAuthCreds } from '@whiskeysockets/baileys';
const diagnostics=[];
const labels=new Set(['connected to WA','handshake recv from WA','not logged in, attempting registration...','Noise handler transitioned to Transport state','error in validating connection','connection errored','connection closed']);
const record=(...args)=>{const label=args.find(arg=>typeof arg==='string'&&labels.has(arg));if(label&&diagnostics.length<80)diagnostics.push({label});};
const logger={level:'silent',child(){return this},trace:record,debug:record,info:record,warn:record,error:record,fatal:record};
const socket=makeWASocket({logger,auth:{creds:initAuthCreds(),keys:{get:async()=>({}),set:async()=>{}}},markOnlineOnConnect:false,browser:Browsers.ubuntu('Desktop'),syncFullHistory:true,connectTimeoutMs:25000});
socket.ws.on('message',data=>{if(diagnostics.length<80)diagnostics.push({label:'frame-received',length:data.length});});
let timer;
try {
 await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error('Anonymous handshake timeout')),30000);
  socket.ev.on('connection.update',update=>{
   if(update.qr)resolve();
   if(update.connection==='close'){diagnostics.push({label:'connection-close',status:update.lastDisconnect?.error?.output?.statusCode??null});reject(new Error('Anonymous upstream closed'));}
  });
 });
 console.log(JSON.stringify({ok:true,check:'anonymous-noise-handshake-pairing-ready',diagnostics},null,2));
} catch(error) {console.log(JSON.stringify({ok:false,error:error.message,diagnostics},null,2));process.exitCode=1;}
finally {clearTimeout(timer);socket.end(undefined);}
