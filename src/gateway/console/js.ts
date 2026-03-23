/**
 * Returns the full browser-side JavaScript for the AgentFlyer web console.
 * Token and port are injected server-side so no additional auth state is needed.
 */
export function buildJs(token: string, port: number): string {
  return `
(function(){
  'use strict';
  const TOKEN=${JSON.stringify(token)};
  const GPORT=${port};

  // ── Toast notifications ─────────────────────────────────────────────────
  let _toastRoot = null;
  function getToastRoot(){
    if(!_toastRoot) _toastRoot = document.getElementById('toast-root');
    return _toastRoot;
  }
  function toast(msg, type='info', dur=3200){
    const root = getToastRoot();
    if(!root) return;
    const el = document.createElement('div');
    el.className = 'toast '+type;
    el.innerHTML = '<span class="t-icon"></span><span class="t-msg">'+esc(msg)+'</span>';
    root.appendChild(el);
    const remove = ()=>{
      el.classList.add('out');
      el.addEventListener('animationend', ()=>el.remove(), {once:true});
    };
    const tid = setTimeout(remove, dur);
    el.addEventListener('click',()=>{ clearTimeout(tid); remove(); });
  }

  // ── Custom confirm dialog ───────────────────────────────────────────────
  function confirm2(msg){
    return new Promise(resolve=>{
      const bg = document.createElement('div');
      bg.className='modal-bg';
      bg.innerHTML = \`<div class="modal">
        <h3>Confirm</h3>
        <p>\${esc(msg)}</p>
        <div class="modal-actions">
          <button class="btn" id="_mc">Cancel</button>
          <button class="btn danger" id="_mo">Confirm</button>
        </div></div>\`;
      document.body.appendChild(bg);
      const close = val=>{
        bg.classList.add('out');
        bg.addEventListener('animationend',()=>bg.remove(),{once:true});
        resolve(val);
      };
      bg.querySelector('#_mc').addEventListener('click',()=>close(false));
      bg.querySelector('#_mo').addEventListener('click',()=>close(true));
      bg.addEventListener('click',e=>{ if(e.target===bg) close(false); });
    });
  }

  // ── Minimal Markdown renderer ────────────────────────────────────────────
  function md(text){
    if(!text) return '';
    let s = String(text);
    // Code blocks first (protect from other rules)
    const codeBlocks = [];
    s = s.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_,lang,code)=>{
      codeBlocks.push('<pre><code class="lang-'+esc(lang)+'">'+esc(code.replace(/\\n$/,''))+'</code></pre>');
      return '%%CB'+(codeBlocks.length-1)+'%%';
    });
    // Inline code
    const inlineCodes = [];
    s = s.replace(/\`([^\`]+)\`/g, (_,c)=>{
      inlineCodes.push('<code>'+esc(c)+'</code>');
      return '%%IC'+(inlineCodes.length-1)+'%%';
    });
    // Escape remaining HTML
    s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Headings
    s = s.replace(/^### (.+)$/gm,'<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm,'<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm,'<h1>$1</h1>');
    // Bold / italic
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
    s = s.replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
    // Blockquotes
    s = s.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
    // Unordered lists
    s = s.replace(/((?:^[\\-\\*] .+\\n?)+)/gm, m=>{
      const items = m.trim().split('\\n').map(i=>'<li>'+i.replace(/^[\\-\\*] /,'')+' </li>').join('');
      return '<ul>'+items+'</ul>';
    });
    // Links
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Paragraphs (double newline)
    s = s.split(/\\n{2,}/).map(p=>{
      p = p.trim();
      if(!p) return '';
      if(/^<(h[1-3]|ul|ol|pre|blockquote)/.test(p)) return p;
      return '<p>'+p.replace(/\\n/g,' ')+'</p>';
    }).filter(Boolean).join('\\n');
    // Restore placeholders
    codeBlocks.forEach((b,i)=>{ s=s.replace('%%CB'+i+'%%',b); });
    inlineCodes.forEach((c,i)=>{ s=s.replace(new RegExp('%%IC'+i+'%%','g'),c); });
    return s;
  }

  // ── XSS-safe HTML escape ────────────────────────────────────────────────
  function esc(s){
    return String(s??'')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtUptime(ms){
    const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
    if(d>0) return d+'d '+String(h%24).padStart(2,'0')+'h';
    if(h>0) return h+'h '+String(m%60).padStart(2,'0')+'m';
    if(m>0) return m+'m '+String(s%60).padStart(2,'0')+'s';
    return s+'s';
  }

  function fmtTs(ts){
    if(!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  }

  // ── RPC helper ──────────────────────────────────────────────────────────
  async function rpc(method, params){
    const res = await fetch(\`http://127.0.0.1:\${GPORT}/rpc\`, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      body: JSON.stringify({id:1, method, params: params ?? {}})
    });
    const json = await res.json();
    if(json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  }

  // ── Connection status ────────────────────────────────────────────────────
  const connEl = document.getElementById('conn');
  const connText = connEl.querySelector('.text');

  async function checkConn(){
    try{
      await rpc('gateway.ping');
      connEl.className='ok';connText.textContent='Connected';
    } catch {
      connEl.className='err';connText.textContent='Offline';
    }
  }
  checkConn();
  setInterval(checkConn, 5000);

  // ── Tab management ───────────────────────────────────────────────────────
  const tabInited = new Set();
  function switchTab(name){
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('show'));
    document.getElementById('tab-'+name).classList.add('show');
    document.querySelectorAll('#nav button').forEach(b => b.classList.remove('active'));
    document.getElementById('nav-'+name).classList.add('active');
    if(!tabInited.has(name)){
      tabInited.add(name);
      const fn = tabInits[name];
      if(fn) fn();
    }
  }
  document.querySelectorAll('#nav button').forEach(b=>{
    b.addEventListener('click',()=>switchTab(b.dataset.tab));
  });

  // ── OVERVIEW ────────────────────────────────────────────────────────────
  const tabInits = {};
  tabInits.overview = async function initOverview(){
    const [status, agList] = await Promise.all([
      rpc('gateway.status'),
      rpc('agent.list')
    ]);
    document.getElementById('ov-version').textContent = status.version ?? '—';
    document.getElementById('ov-uptime').textContent  = fmtUptime(status.uptime ?? 0);
    document.getElementById('ov-agents').textContent  = status.agents ?? 0;
    document.getElementById('ov-port').textContent    = GPORT;

    const list = agList.agents ?? [];
    document.getElementById('ov-agent-list').innerHTML = list.length ? list.map(a=>
      \`<tr><td>\${esc(a.agentId)}</td>
           <td><span class="badge green">running</span></td>
           <td><button class="btn small" onclick="window.chatWith('\${esc(a.agentId)}')">Chat</button></td>
       </tr>\`
    ).join('') : '<tr><td colspan=3 class="empty">No agents</td></tr>';
  };

  // ── AGENTS ──────────────────────────────────────────────────────────────
  tabInits.agents = async function initAgents(){
    const container = document.getElementById('agents-container');
    container.innerHTML = '<div class="spinner spinner-lg" style="margin:24px auto"></div>';
    const [agList, cfg] = await Promise.all([rpc('agent.list'), rpc('config.get')]);
    const ids = (agList.agents ?? []).map(a => a.agentId);
    const agentCfgs = {};
    for(const a of (cfg.agents ?? [])) agentCfgs[a.id] = a;

    container.innerHTML = ids.map(id=>{
      const c = agentCfgs[id] ?? {};
      const ws   = c.workspace  ?? '—';
      const mdl  = c.model      ?? (cfg.defaults?.model ?? '—');
      const role = c.mesh?.role ?? '—';
      const lang = c.persona?.language ?? '—';
      return \`<div class="agent-card">
        <div class="agent-card-top">
          <div class="agent-avatar">🤖</div>
          <div>
            <div class="agent-name">\${esc(c.name ?? id)}</div>
            <div class="agent-id">\${esc(id)}</div>
          </div>
          <span class="badge green" style="margin-left:auto">running</span>
        </div>
        <div class="agent-meta">
          <div class="meta-item"><div class="meta-label">Model</div><div class="meta-value">\${esc(mdl)}</div></div>
          <div class="meta-item"><div class="meta-label">Role</div><div class="meta-value">\${esc(role)}</div></div>
          <div class="meta-item"><div class="meta-label">Language</div><div class="meta-value">\${esc(lang)}</div></div>
          <div class="meta-item" style="grid-column:1/-1"><div class="meta-label">Workspace</div><div class="meta-value">\${esc(ws)}</div></div>
        </div>
        <div class="agent-actions">
          <button class="btn small" onclick="window.reloadAgent('\${esc(id)}')">↺ Reload</button>
          <button class="btn small danger" onclick="window.clearAgent('\${esc(id)}')">⌫ Clear History</button>
          <button class="btn small primary" onclick="window.chatWith('\${esc(id)}')">Chat →</button>
        </div>
      </div>\`;
    }).join('') || '<p class="empty">No agents running.</p>';
  };

  window.reloadAgent = async function(id){
    try{
      const r = await rpc('agent.reload', {agentId: id});
      toast('Reloaded: '+(r.reloaded?.join(', ') ?? id), 'success');
    } catch(e){ toast('Reload failed: '+e.message, 'error'); }
  };

  window.clearAgent = async function(id){
    if(!await confirm2('Clear conversation history for agent "'+id+'"?')) return;
    try{
      await rpc('session.clear', {agentId: id});
      toast('History cleared for '+id, 'success');
    } catch(e){ toast('Error: '+e.message, 'error'); }
  };

  // ── CHAT ────────────────────────────────────────────────────────────────
  window.chatWith = function(agentId){
    switchTab('chat');
    const sel = document.getElementById('chat-sel');
    if(sel) for(const opt of sel.options) if(opt.value===agentId) sel.value=agentId;
  };

  tabInits.chat = async function initChat(){
    const agList = await rpc('agent.list');
    const sel = document.getElementById('chat-sel');
    sel.innerHTML = (agList.agents ?? []).map(a=>
      \`<option value="\${esc(a.agentId)}">\${esc(a.name ?? a.agentId)}</option>\`
    ).join('');

    const input   = document.getElementById('chat-input');
    const msgs    = document.getElementById('chat-msgs');
    const sendBtn = document.getElementById('chat-send');
    const clearBtn= document.getElementById('chat-clear-btn');

    clearBtn.onclick = ()=>{ msgs.innerHTML=''; };

    function addMsg(role, htmlContent){
      const el   = document.createElement('div');
      el.className = 'msg '+role;
      el.innerHTML = htmlContent||'';
      const ts = document.createElement('div');
      ts.className = 'msg-time';
      ts.textContent = new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
      el.appendChild(ts);
      msgs.appendChild(el);
      msgs.scrollTop = msgs.scrollHeight;
      return el;
    }

    function makeCopyBtn(el){
      const btn = document.createElement('button');
      btn.className='btn small ghost';
      btn.style.cssText='position:absolute;top:8px;right:8px;opacity:0;transition:opacity .15s;padding:2px 7px;font-size:10px';
      btn.textContent='Copy';
      el.style.position='relative';
      el.addEventListener('mouseenter',()=>btn.style.opacity='1');
      el.addEventListener('mouseleave',()=>btn.style.opacity='0');
      btn.addEventListener('click',()=>{
        const text = el.innerText.replace(/\\nCopy$/,'').replace(/^Copy\\n/,'');
        navigator.clipboard.writeText(text).then(()=>{
          btn.textContent='Copied!';
          setTimeout(()=>btn.textContent='Copy',1500);
        });
      });
      el.appendChild(btn);
    }

    let rawText = '';
    async function send(){
      const text = input.value.trim();
      if(!text) return;
      const agentId = sel.value;
      if(!agentId){ toast('Select an agent first.','warning'); return; }
      input.value='';
      addMsg('user', esc(text));
      rawText = '';
      const assistantEl = document.createElement('div');
      assistantEl.className='msg assistant streaming-cursor';
      msgs.appendChild(assistantEl);
      msgs.scrollTop = msgs.scrollHeight;
      sendBtn.disabled=true;

      try{
        const res = await fetch(\`http://127.0.0.1:\${GPORT}/chat\`, {
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
          body: JSON.stringify({agentId, message: text, thread:'console'})
        });
        if(!res.ok) throw new Error('HTTP '+res.status);
        if(!res.body) throw new Error('No response stream');

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while(true){
          const {done, value} = await reader.read();
          if(done) break;
          buf += dec.decode(value, {stream:true});
          const lines = buf.split('\\n');
          buf = lines.pop() ?? '';
          for(const line of lines){
            if(!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if(raw==='[DONE]') break;
            try{
              const chunk = JSON.parse(raw);
              if(chunk.type==='text'){
                rawText += chunk.text ?? '';
                assistantEl.innerHTML = md(rawText);
                const ts=document.createElement('div');
                ts.className='msg-time';
                ts.textContent=new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
                assistantEl.appendChild(ts);
              }
              if(chunk.type==='thinking'){
                const t=document.createElement('div');
                t.className='msg thinking';
                t.textContent='Thinking: '+chunk.text;
                msgs.insertBefore(t, assistantEl);
              }
            } catch{ /* skip */ }
          }
          msgs.scrollTop = msgs.scrollHeight;
        }
        assistantEl.classList.remove('streaming-cursor');
        makeCopyBtn(assistantEl);
      } catch(e){
        assistantEl.classList.remove('streaming-cursor');
        assistantEl.innerHTML='<span style="color:var(--red)">⚠ '+esc(e.message)+'</span>';
      } finally {
        sendBtn.disabled=false;
      }
    }

    sendBtn.onclick = send;
    input.addEventListener('keydown', e=>{
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }
    });
    input.focus();
  };

  // ── LOGS ─────────────────────────────────────────────────────────────────
  const activeLevels = new Set(['debug','info','warn','error']);
  let logSearch = '';
  let logEs = null;

  tabInits.logs = function initLogs(){
    const box   = document.getElementById('log-box');
    const search= document.getElementById('log-search');

    search.addEventListener('input', ()=>{ logSearch=search.value.toLowerCase(); });

    document.querySelectorAll('#log-controls .lbtn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const lvl = btn.dataset.level;
        if(activeLevels.has(lvl)) activeLevels.delete(lvl); else activeLevels.add(lvl);
        btn.classList.toggle('active', activeLevels.has(lvl));
      });
      btn.classList.add('active');
    });

    if(logEs) logEs.close();
    logEs = new EventSource(\`http://127.0.0.1:\${GPORT}/api/logs?token=\${encodeURIComponent(TOKEN)}\`);
    logEs.onmessage = function(e){
      let entry;
      try{ entry = JSON.parse(e.data); } catch{ return; }
      renderLog(entry, box);
    };
    logEs.onerror = ()=>{
      const el=document.createElement('div');
      el.className='log-line system';
      el.textContent='[SSE disconnected]';
      box.appendChild(el);
    };
  };

  function renderLog(entry, box){
    const lvl = entry.level ?? 'info';
    if(!activeLevels.has(lvl)) return;
    const msg = (entry.msg ?? '') + ' ' + extraFields(entry);
    if(logSearch && !msg.toLowerCase().includes(logSearch) && !((entry.name??'').toLowerCase().includes(logSearch))) return;
    const line = document.createElement('div');
    line.className = 'log-line '+lvl;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    line.innerHTML =
      \`<span class="lt">\${new Date(entry.ts||Date.now()).toISOString().slice(11,23)}</span>\` +
      \`<span class="ln badge \${lvlBadge(lvl)}">\${esc(lvl.toUpperCase())}</span>\` +
      \`<span class="lm">\${esc(entry.name??'')} \${esc(entry.msg??'')}\${extraHtml(entry)}</span>\`;
    box.appendChild(line);
    if(atBottom) box.scrollTop = box.scrollHeight;
    // Limit DOM size
    while(box.children.length > 1000) box.removeChild(box.firstChild);
  }

  function lvlBadge(l){ return {debug:'',info:'blue',warn:'yellow',error:'red'}[l]??''; }

  function extraFields(entry){
    const skip=new Set(['ts','level','name','msg']);
    return Object.entries(entry).filter(([k])=>!skip.has(k)).map(([k,v])=>k+':'+String(v)).join(' ');
  }
  function extraHtml(entry){
    const skip=new Set(['ts','level','name','msg']);
    const pairs = Object.entries(entry).filter(([k])=>!skip.has(k));
    if(!pairs.length) return '';
    return ' <span style="color:var(--muted)">'+ pairs.map(([k,v])=>esc(k)+'='+esc(String(v))).join(' ')+'</span>';
  }

  // scrollback sync for level filter changes
  document.getElementById('log-controls')?.addEventListener('click',()=>{
    const box = document.getElementById('log-box');
    if(box) box.scrollTop = box.scrollHeight;
  });

  // ── SCHEDULER ────────────────────────────────────────────────────────────
  tabInits.scheduler = async function initScheduler(){
    await renderScheduler();
  };

  async function renderScheduler(){
    let tasks=[];
    try{ const r = await rpc('scheduler.list'); tasks = r.tasks ?? []; } catch(e){ tasks=[]; }
    const tbody = document.getElementById('sched-tbody');
    tbody.innerHTML = tasks.length ? tasks.map(t=>\`
      <tr>
        <td>\${esc(t.name)}</td>
        <td>\${esc(t.agentId)}</td>
        <td><code>\${esc(t.cronExpr)}</code></td>
        <td>\${t.runCount??0}</td>
        <td>\${fmtTs(t.lastRunAt)}</td>
        <td>\${t.nextRunAt ? fmtTs(t.nextRunAt) : '—'}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(t.lastResult??'')}</td>
        <td><button class="btn small danger" onclick="cancelTask('\${esc(t.id)}')">✕</button></td>
      </tr>
    \`).join('') : '<tr><td colspan=8 class="empty">No scheduled tasks.</td></tr>';
  }

  window.cancelTask = async function(id){
    if(!await confirm2('Cancel this scheduled task?')) return;
    try{
      await rpc('scheduler.cancel', {taskId:id});
      toast('Task cancelled.','success');
      await renderScheduler();
    } catch(e){ toast('Error: '+e.message,'error'); }
  };

  // ── CONFIG ───────────────────────────────────────────────────────────────
  tabInits.config = async function initConfig(){
    let cfg;
    try{ cfg = await rpc('config.get'); } catch(e){ toast('Failed to load config: '+e.message,'error'); return; }
    const area = document.getElementById('cfg-area');
    area.value = JSON.stringify(cfg, null, 2);
    document.getElementById('cfg-validate').onclick = validateCfg;
    document.getElementById('cfg-save').onclick    = saveCfg;
  };

  function validateCfg(){
    const area = document.getElementById('cfg-area');
    const msg  = document.getElementById('cfg-msg');
    try{
      JSON.parse(area.value);
      msg.className='ok';msg.innerHTML='&#10004; Valid JSON';msg.style.display='flex';
      toast('Valid JSON','success',2000);
    } catch(e){
      msg.className='err';msg.innerHTML='&#10005; '+esc(e.message);msg.style.display='flex';
    }
  }

  async function saveCfg(){
    const area = document.getElementById('cfg-area');
    const msg  = document.getElementById('cfg-msg');
    let parsed;
    try{ parsed = JSON.parse(area.value); }
    catch(e){ msg.className='err';msg.innerHTML='&#10005; '+esc(e.message);msg.style.display='flex'; return; }
    try{
      const r = await rpc('config.save', parsed);
      msg.className='ok';
      msg.innerHTML='&#10004; Saved. Reloaded: '+esc(r.reloaded?.join(', ')||'none');
      msg.style.display='flex';
      toast('Config saved & reloaded.','success');
    } catch(e){
      msg.className='err';msg.innerHTML='&#10005; '+esc(e.message);msg.style.display='flex';
      toast('Save failed: '+e.message,'error');
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  switchTab('overview');
})();
`;
}
