"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";

function findTransportSymbols(source) {
  const classMatch = source.match(new RegExp(`var (${IDENT})=class\\{kind=\\\`websocket\\\``));
  const selectionLogIndex = source.indexOf("selected app-server transport");
  if (classMatch == null || selectionLogIndex < 0 || classMatch.index >= selectionLogIndex) return null;

  const sshClassSource = source.slice(classMatch.index, selectionLogIndex);
  const webSocketMatch = sshClassSource.match(
    new RegExp(`new (${IDENT})\\.(${IDENT})\\((${IDENT}),\\{perMessageDeflate:!1,createConnection:`),
  );
  if (webSocketMatch == null) return null;
  const [, namespace, webSocketClass, webSocketUrl] = webSocketMatch;
  const lifecycleMatch = sshClassSource.match(
    new RegExp(
      `return ${namespace}\\.(${IDENT})\\((${IDENT}),\\{onPongTimeout:[\\s\\S]{0,160}?\\}\\),new ${namespace}\\.(${IDENT})\\(\\2\\)`,
    ),
  );
  if (lifecycleMatch == null) return null;

  return {
    namespace,
    webSocketClass,
    webSocketUrl,
    adapterClass: lifecycleMatch[3],
    keepAlive: lifecycleMatch[1],
  };
}

function applySharedAppServerSocketPatch(source) {
  if (source.includes("class CodexLinuxSharedAppServerSocketTransport")) return source;

  const symbols = findTransportSymbols(source);
  if (symbols == null) {
    console.warn("WARN: Could not find SSH WebSocket transport for shared app-server socket patch");
    return source;
  }

  const selectionLogIndex = source.indexOf("selected app-server transport");
  const factoryStart = source.lastIndexOf("function ", selectionLogIndex);
  const factoryEnd = source.indexOf("function ", selectionLogIndex + 1);
  if (selectionLogIndex < 0 || factoryStart < 0 || factoryEnd < 0) {
    console.warn("WARN: Could not find local transport factory for shared app-server socket patch");
    return source;
  }
  const factorySource = source.slice(factoryStart, factoryEnd);
  const localFallbackPattern = new RegExp(
    `(if\\(${symbols.namespace}\\.(${IDENT})\\(e\\.hostConfig\\)\\)return [^;]+;)(let (${IDENT})=(${IDENT})\\(e\\.hostConfig\\);return \\4\\?)`,
  );
  const localFallbackMatch = factorySource.match(localFallbackPattern);
  if (localFallbackMatch == null) {
    console.warn("WARN: Could not find local transport fallback for shared app-server socket patch");
    return source;
  }

  const classSource =
    "class CodexLinuxSharedAppServerSocketTransport{" +
    "kind=`websocket`;proxyStreams=new Set;authority=null;" +
    "constructor(e){this.socketPath=e}" +
    "supportsReconnect(){return!0}" +
    "dispose(){for(let e of this.proxyStreams)e.destroy();this.proxyStreams.clear();this.authority?.kill();this.authority=null;try{require(`node:fs`).unlinkSync(this.socketPath)}catch(e){if(e?.code!==`ENOENT`)throw e}}" +
    "async ensureAuthority(){if(this.authority&&this.authority.exitCode==null)return;let e=process.env.CODEX_CLI_PATH;if(!e)throw Error(`shared app-server socket requires CODEX_CLI_PATH`);let t=require(`node:fs`),n=require(`node:path`);t.mkdirSync(n.dirname(this.socketPath),{recursive:!0,mode:448});try{t.unlinkSync(this.socketPath)}catch(e){if(e?.code!==`ENOENT`)throw e}this.authority=require(`node:child_process`).spawn(e,[`app-server`,`--listen`,`unix://${this.socketPath}`],{env:process.env,stdio:`ignore`});for(let e=0;e<100;e++){if(this.authority.exitCode!=null)throw Error(`shared app-server authority exited before socket creation`);try{if(t.statSync(this.socketPath).isSocket())return}catch(e){if(e?.code!==`ENOENT`)throw e}await new Promise(e=>setTimeout(e,100))}this.authority.kill();this.authority=null;throw Error(`shared app-server socket creation timed out`)}" +
    "createProxyStream(){let c=process.env.CODEX_CLI_PATH;if(!c)throw Error(`shared app-server socket requires CODEX_CLI_PATH`);let e=require(`node:child_process`).spawn(c,[`app-server`,`proxy`,`--sock`,this.socketPath],{env:process.env,stdio:[`pipe`,`pipe`,`pipe`]}),t=e.stdin,n=e.stdout,r=e.stderr;if(t==null||n==null||r==null)throw e.kill(),Error(`shared app-server proxy stdio was unavailable`);let i=``;r.on(`data`,e=>{i=`${i}${e.toString(`utf8`)}`.slice(-4000)});let a=new(require(`node:stream`).Duplex)({read(){n.resume()},write(e,n,r){t.write(e,n,r)},final(e){t.end(),e()},destroy(t,n){e.kill(),n(t)}});Object.assign(a,{setKeepAlive:()=>a,setNoDelay:()=>a,setTimeout:()=>a});let o=e=>a.destroy(e);t.on(`error`,o),n.on(`data`,e=>{a.push(e)||n.pause()}),n.on(`end`,()=>a.push(null)),e.on(`error`,o),e.on(`close`,(e,n)=>{t.removeListener(`error`,o),e===0?a.push(null):a.destroy(Error(`shared app-server proxy exited (${e??n??`unknown`}): ${i.trim()}`))}),this.proxyStreams.add(a),a.once(`close`,()=>this.proxyStreams.delete(a));return a}" +
    `async connect(){await this.ensureAuthority();let e={current:null},t=new ${symbols.namespace}.${symbols.webSocketClass}(${symbols.webSocketUrl},{perMessageDeflate:!1,createConnection:()=>(e.current=this.createProxyStream(),e.current)});t.once(\`close\`,()=>e.current?.destroy());await new Promise((n,r)=>{let i=setTimeout(()=>{r(Error(\`shared app-server websocket open timed out\`))},3e4);i.unref();let a=()=>{clearTimeout(i),t.off(\`error\`,o),t.off(\`close\`,s)},o=e=>{a(),r(e)},s=()=>{a(),r(Error(\`shared app-server websocket closed before opening\`))};t.once(\`open\`,()=>{a(),n()}),t.once(\`error\`,o),t.once(\`close\`,s)});${symbols.namespace}.${symbols.keepAlive}(t,{onPongTimeout:()=>t.terminate()});return new ${symbols.namespace}.${symbols.adapterClass}(t)}}`;

  const patchedFactory = factorySource.replace(
    localFallbackPattern,
    `$1if(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET&&e.hostConfig.kind===\`local\`)return new CodexLinuxSharedAppServerSocketTransport(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET);$3`,
  );
  return source.slice(0, factoryStart) + classSource + patchedFactory + source.slice(factoryEnd);
}

const descriptors = [
  {
    id: "main-process-shared-app-server-socket",
    phase: "main-bundle",
    order: 140,
    ciPolicy: "optional",
    apply: applySharedAppServerSocketPatch,
  },
];

module.exports = {
  applySharedAppServerSocketPatch,
  descriptors,
  findTransportSymbols,
};
