/** Dark-theme CSS for the AgentFlyer web console. */
export const css = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root{
  /* Palette */
  --bg:        #080c10;
  --bg2:       #0d1117;
  --panel:     #111820;
  --panel2:    #161d27;
  --panel3:    #1c2433;
  --border:    #21303f;
  --border2:   #2a3f52;
  --text:      #cdd9e5;
  --text2:     #adbac7;
  --muted:     #545d68;
  --accent:    #539bf5;
  --accent2:   #6cb6ff;
  --green:     #57ab5a;
  --green2:    #46954a;
  --yellow:    #c69026;
  --yellow2:   #daaa3f;
  --red:       #e5534b;
  --red2:      #c93c37;
  --purple:    #b083f0;
  --cyan:      #39c5cf;
  --orange:    #f69d50;

  /* Surfaces */
  --glass:     rgba(13,17,23,.72);
  --glow-a:    rgba(83,155,245,.15);
  --glow-g:    rgba(87,171,90,.12);
  --glow-r:    rgba(229,83,75,.12);

  /* Shape */
  --radius:    8px;
  --radius-lg: 12px;
  --radius-xl: 16px;

  /* Type */
  --font:      'Inter', system-ui, -apple-system, sans-serif;
  --mono:      'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace;

  /* Motion */
  --ease:      cubic-bezier(.16,1,.3,1);
  --fast:      120ms;
  --mid:       220ms;
  --slow:      380ms;
}

html{scroll-behavior:smooth}
body{
  background:var(--bg);
  color:var(--text);
  font-family:var(--font);
  font-size:13px;
  line-height:1.5;
  display:flex;
  height:100vh;
  overflow:hidden;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent2);text-decoration:underline}
::selection{background:rgba(83,155,245,.25)}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}

/* ── Sidebar ───────────────────────────────────────────────────────────── */
#sidebar{
  width:200px;flex-shrink:0;
  background:linear-gradient(180deg,var(--panel) 0%,var(--bg2) 100%);
  border-right:1px solid var(--border);
  display:flex;flex-direction:column;
  padding:0;
  position:relative;
  z-index:10;
}
#sidebar::after{
  content:'';
  position:absolute;right:-1px;top:0;bottom:0;width:1px;
  background:linear-gradient(180deg,transparent,var(--border2) 20%,var(--border2) 80%,transparent);
}

#sidebar-header{
  padding:16px 16px 14px;
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:10px;
}
.logo-mark{
  width:30px;height:30px;border-radius:8px;
  background:linear-gradient(135deg,var(--accent) 0%,var(--purple) 100%);
  display:flex;align-items:center;justify-content:center;
  font-size:15px;flex-shrink:0;
  box-shadow:0 0 12px var(--glow-a);
}
.brand-name{font-size:13px;font-weight:600;color:var(--text);letter-spacing:.3px}
.brand-ver{font-size:10px;color:var(--muted);margin-top:1px}

#nav{flex:1;display:flex;flex-direction:column;gap:2px;padding:10px 8px;overflow-y:auto}
.nav-section{
  font-size:9px;font-weight:600;color:var(--muted);
  letter-spacing:.8px;text-transform:uppercase;
  padding:10px 10px 4px;
}
#nav button{
  background:none;border:none;color:var(--text2);
  width:100%;text-align:left;
  padding:8px 10px;border-radius:var(--radius);
  cursor:pointer;font-family:var(--font);font-size:12px;font-weight:500;
  transition:background var(--fast) var(--ease), color var(--fast) var(--ease), transform var(--fast);
  display:flex;align-items:center;gap:9px;
  position:relative;
}
#nav button .nav-icon{font-size:14px;line-height:1;width:18px;text-align:center;flex-shrink:0}
#nav button:hover{background:var(--panel2);color:var(--text)}
#nav button:active{transform:scale(.97)}
#nav button.active{
  background:linear-gradient(135deg,rgba(83,155,245,.18),rgba(83,155,245,.08));
  color:var(--accent2);
  box-shadow:inset 0 0 0 1px rgba(83,155,245,.2);
}
#nav button.active::before{
  content:'';position:absolute;left:0;top:20%;bottom:20%;
  width:3px;border-radius:0 3px 3px 0;
  background:var(--accent);
  box-shadow:0 0 8px var(--accent);
}

#conn{
  padding:10px 14px;
  border-top:1px solid var(--border);
  font-size:11px;color:var(--muted);
  display:flex;align-items:center;gap:7px;
  background:var(--bg2);
}
#conn .dot{
  width:7px;height:7px;border-radius:50%;
  background:var(--muted);
  flex-shrink:0;
  transition:background var(--mid),box-shadow var(--mid);
}
#conn.ok .dot{background:var(--green);box-shadow:0 0 6px var(--green)}
#conn.err .dot{background:var(--red);box-shadow:0 0 6px var(--red);animation:pulse-dot 1.5s ease infinite}
#conn.ok .text{color:var(--text2)}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.4}}

/* ── Main content ─────────────────────────────────────────────────────── */
#main{
  flex:1;overflow-y:auto;padding:24px 28px;
  background:radial-gradient(ellipse at 60% 0%,rgba(83,155,245,.04) 0%,transparent 60%),var(--bg);
}
.tab{display:none;max-width:960px;animation:none}
.tab.show{display:block;animation:tab-in var(--mid) var(--ease) both}
@keyframes tab-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

.page-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:22px;gap:12px;
}
.page-title{font-size:17px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px}
.page-title .icon{font-size:18px}

/* ── Stat cards ───────────────────────────────────────────────────────── */
.cards{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:12px;margin-bottom:24px;
}
.card{
  background:var(--panel);
  border:1px solid var(--border);
  border-radius:var(--radius-lg);
  padding:16px 18px;
  position:relative;overflow:hidden;
  transition:border-color var(--fast),box-shadow var(--fast);
}
.card:hover{border-color:var(--border2);box-shadow:0 4px 20px rgba(0,0,0,.3)}
.card::before{
  content:'';position:absolute;inset:0;
  background:linear-gradient(135deg,rgba(255,255,255,.015) 0%,transparent 60%);
  pointer-events:none;
}
.card .c-icon{font-size:20px;margin-bottom:8px;opacity:.9}
.card .c-label{font-size:10px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
.card .c-value{font-size:22px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
.card .c-sub{font-size:11px;color:var(--muted);margin-top:3px}
.card.accent-blue{border-left:3px solid var(--accent)}
.card.accent-green{border-left:3px solid var(--green)}
.card.accent-purple{border-left:3px solid var(--purple)}
.card.accent-yellow{border-left:3px solid var(--yellow)}

/* ── Section ──────────────────────────────────────────────────────────── */
.section{margin-bottom:24px}
.section-title{
  font-size:11px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.6px;
  margin-bottom:10px;display:flex;align-items:center;gap:6px;
}
.section-title::after{content:'';flex:1;height:1px;background:var(--border)}

/* ── Agent cards ──────────────────────────────────────────────────────── */
.agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.agent-card{
  background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:16px 18px;
  transition:border-color var(--fast),transform var(--fast),box-shadow var(--fast);
  position:relative;overflow:hidden;
}
.agent-card:hover{
  border-color:var(--border2);
  transform:translateY(-2px);
  box-shadow:0 8px 30px rgba(0,0,0,.3);
}
.agent-card-top{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.agent-avatar{
  width:34px;height:34px;border-radius:9px;flex-shrink:0;
  background:linear-gradient(135deg,var(--accent),var(--purple));
  display:flex;align-items:center;justify-content:center;
  font-size:15px;box-shadow:0 0 10px rgba(83,155,245,.2);
}
.agent-name{font-size:13px;font-weight:600;color:var(--text)}
.agent-id{font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:1px}
.agent-meta{
  display:grid;grid-template-columns:1fr 1fr;
  gap:6px 14px;margin-bottom:14px;
}
.meta-item{font-size:11px}
.meta-label{color:var(--muted);font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.4px;margin-bottom:1px}
.meta-value{color:var(--text2);font-family:var(--mono);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-actions{display:flex;gap:7px;flex-wrap:wrap}

/* ── Buttons ──────────────────────────────────────────────────────────── */
.btn{
  background:var(--panel2);
  border:1px solid var(--border2);
  color:var(--text2);
  padding:6px 14px;border-radius:var(--radius);
  cursor:pointer;font-family:var(--font);font-size:12px;font-weight:500;
  transition:background var(--fast),color var(--fast),border-color var(--fast),box-shadow var(--fast),transform var(--fast);
  display:inline-flex;align-items:center;gap:6px;
  user-select:none;
}
.btn:hover{background:var(--panel3);color:var(--text);border-color:var(--border2);box-shadow:0 2px 8px rgba(0,0,0,.2)}
.btn:active{transform:scale(.96)}
.btn.primary{
  background:linear-gradient(135deg,var(--accent) 0%,#3a7ed8 100%);
  border:none;color:#fff;
  box-shadow:0 2px 10px rgba(83,155,245,.3);
}
.btn.primary:hover{box-shadow:0 4px 18px rgba(83,155,245,.45);filter:brightness(1.08)}
.btn.danger{background:transparent;border-color:rgba(229,83,75,.4);color:var(--red)}
.btn.danger:hover{background:rgba(229,83,75,.1);border-color:var(--red)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--text2)}
.btn.ghost:hover{background:var(--panel2)}
.btn.small{padding:4px 9px;font-size:11px;border-radius:6px}
.btn:disabled{opacity:.45;cursor:not-allowed;pointer-events:none}

/* ── Tables ───────────────────────────────────────────────────────────── */
.table-wrap{
  background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius-lg);overflow:hidden;
}
table{width:100%;border-collapse:collapse;font-size:12px}
thead{background:rgba(255,255,255,.025)}
th{
  text-align:left;padding:10px 14px;
  color:var(--muted);border-bottom:1px solid var(--border);
  font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.5px;
  white-space:nowrap;
}
td{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle;word-break:break-word}
tbody tr{transition:background var(--fast)}
tbody tr:hover td{background:rgba(255,255,255,.03)}
tbody tr:last-child td{border-bottom:none}
code{font-family:var(--mono);font-size:11px;background:var(--panel3);padding:2px 6px;border-radius:4px;color:var(--accent2)}

/* ── Badges ───────────────────────────────────────────────────────────── */
.badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:2px 8px;border-radius:20px;
  font-size:10px;font-weight:600;letter-spacing:.3px;
}
.badge::before{content:'';width:5px;height:5px;border-radius:50%;flex-shrink:0}
.badge.green{background:rgba(87,171,90,.15);color:var(--green);border:1px solid rgba(87,171,90,.25)}
.badge.green::before{background:var(--green);box-shadow:0 0 4px var(--green)}
.badge.blue{background:rgba(83,155,245,.15);color:var(--accent2);border:1px solid rgba(83,155,245,.25)}
.badge.blue::before{background:var(--accent)}
.badge.yellow{background:rgba(198,144,38,.15);color:var(--yellow2);border:1px solid rgba(198,144,38,.25)}
.badge.yellow::before{background:var(--yellow2)}
.badge.red{background:rgba(229,83,75,.15);color:var(--red);border:1px solid rgba(229,83,75,.25)}
.badge.red::before{background:var(--red);box-shadow:0 0 4px var(--red)}
.badge.purple{background:rgba(176,131,240,.15);color:var(--purple);border:1px solid rgba(176,131,240,.25)}
.badge.purple::before{background:var(--purple)}

/* ── Form inputs ──────────────────────────────────────────────────────── */
input,select,textarea{
  background:var(--panel);border:1px solid var(--border2);color:var(--text);
  border-radius:var(--radius);font-family:var(--font);font-size:12px;
  transition:border-color var(--fast),box-shadow var(--fast);
}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(83,155,245,.15);
}
input::placeholder,textarea::placeholder{color:var(--muted)}
select{padding:6px 10px;cursor:pointer}
select option{background:var(--panel2)}

/* ── Chat ─────────────────────────────────────────────────────────────── */
#tab-chat{display:none}
#tab-chat.show{display:flex;flex-direction:column;height:calc(100vh - 48px)}
#chat-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-shrink:0}
#chat-header label{font-size:12px;color:var(--muted);font-weight:500}
#chat-sel{width:200px;padding:6px 10px}
#chat-clear-btn{margin-left:auto}
#chat-msgs{
  flex:1;overflow-y:auto;
  padding:16px;
  display:flex;flex-direction:column;gap:10px;
  background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius-lg);margin-bottom:12px;
}
.msg{
  max-width:80%;
  padding:10px 14px;border-radius:var(--radius-lg);
  font-size:12.5px;line-height:1.55;word-break:break-word;
  animation:msg-in 200ms var(--ease) both;
}
@keyframes msg-in{from{opacity:0;transform:scale(.96) translateY(4px)}to{opacity:1;transform:none}}
.msg.user{
  align-self:flex-end;
  background:linear-gradient(135deg,rgba(83,155,245,.25),rgba(83,155,245,.15));
  border:1px solid rgba(83,155,245,.25);
  border-bottom-right-radius:4px;
}
.msg.assistant{
  align-self:flex-start;
  background:var(--panel2);border:1px solid var(--border);
  border-bottom-left-radius:4px;
}
.msg.system{
  align-self:center;background:transparent;
  color:var(--muted);font-size:11px;
  border:1px dashed var(--border2);
  border-radius:var(--radius);max-width:90%;
}
.msg.thinking{
  align-self:flex-start;background:transparent;
  color:var(--muted);font-size:11px;font-style:italic;
  border:1px dashed var(--border2);padding:6px 12px;
}
/* Markdown in assistant messages */
.msg.assistant p{margin:.25em 0}
.msg.assistant p:first-child{margin-top:0}
.msg.assistant p:last-child{margin-bottom:0}
.msg.assistant strong{color:var(--text);font-weight:600}
.msg.assistant em{color:var(--text2)}
.msg.assistant code{font-family:var(--mono);font-size:11px;background:rgba(255,255,255,.07);padding:1px 5px;border-radius:4px;color:var(--accent2)}
.msg.assistant pre{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin:.5em 0;overflow-x:auto}
.msg.assistant pre code{background:none;padding:0;font-size:11px;color:var(--text2)}
.msg.assistant ul,.msg.assistant ol{padding-left:1.4em;margin:.25em 0}
.msg.assistant li{margin:.15em 0}
.msg.assistant blockquote{border-left:3px solid var(--border2);padding-left:10px;color:var(--muted);margin:.4em 0}
.msg.assistant h1,.msg.assistant h2,.msg.assistant h3{color:var(--text);font-weight:600;margin:.5em 0 .25em}
.msg.assistant a{color:var(--accent)}
.msg-time{font-size:10px;color:var(--muted);margin-top:4px;text-align:right}
.msg.user .msg-time{text-align:right}
.msg.assistant .msg-time{text-align:left}
.streaming-cursor::after{content:'▊';animation:blink .9s step-end infinite;color:var(--accent);margin-left:1px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
#chat-input-row{display:flex;gap:8px;flex-shrink:0;align-items:flex-end}
#chat-input{
  flex:1;min-height:40px;max-height:120px;
  padding:10px 14px;border-radius:var(--radius-lg);resize:none;
  font-size:12.5px;line-height:1.5;
}
#chat-send{height:40px;align-self:flex-end;white-space:nowrap}

/* ── Logs ─────────────────────────────────────────────────────────────── */
#log-controls{
  display:flex;gap:8px;align-items:center;flex-wrap:wrap;
  margin-bottom:10px;
}
#log-search{padding:6px 12px;width:200px}
.lbtn{
  background:var(--panel2);border:1px solid var(--border);
  color:var(--muted);padding:4px 10px;border-radius:var(--radius);
  cursor:pointer;font-family:var(--mono);font-size:10px;font-weight:600;
  letter-spacing:.5px;transition:all var(--fast);
}
.lbtn.active.lbtn-debug{border-color:var(--border2);color:var(--text2)}
.lbtn.active.lbtn-info{border-color:rgba(83,155,245,.4);color:var(--accent2);background:rgba(83,155,245,.1)}
.lbtn.active.lbtn-warn{border-color:rgba(198,144,38,.4);color:var(--yellow2);background:rgba(198,144,38,.1)}
.lbtn.active.lbtn-error{border-color:rgba(229,83,75,.4);color:var(--red);background:rgba(229,83,75,.1)}
#log-box{
  background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:10px 8px;
  height:calc(100vh - 210px);overflow-y:auto;
  font-family:var(--mono);
}
.log-line{
  padding:2px 8px;border-radius:4px;
  line-height:1.65;display:flex;gap:10px;align-items:baseline;
  transition:background var(--fast);
}
.log-line:hover{background:rgba(255,255,255,.03)}
.log-line .lt{color:var(--muted);flex-shrink:0;font-size:10px;font-variant-numeric:tabular-nums}
.log-line .ln{flex-shrink:0;min-width:42px}
.log-line .lm{flex:1;word-break:break-all;font-size:11px}
.log-line .lk{color:var(--cyan);opacity:.7;font-size:10px}
.log-line.debug .lm{color:var(--muted)}
.log-line.info .lm{color:var(--text2)}
.log-line.warn .lm{color:var(--yellow2)}
.log-line.error .lm{color:var(--red)}
.log-line.error{background:rgba(229,83,75,.05)}
.log-line.warn{background:rgba(198,144,38,.04)}

/* ── Config ───────────────────────────────────────────────────────────── */
#cfg-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
#cfg-area{
  width:100%;padding:14px 16px;
  border-radius:var(--radius-lg);
  font-family:var(--mono);font-size:12px;resize:none;line-height:1.7;
  height:calc(100vh - 210px);
  tab-size:2;
}
#cfg-msg{
  font-size:12px;padding:7px 12px;border-radius:var(--radius);
  display:none;align-items:center;gap:6px;animation:msg-in .15s var(--ease);
}
#cfg-msg.ok{background:rgba(87,171,90,.12);color:var(--green);display:flex;border:1px solid rgba(87,171,90,.2)}
#cfg-msg.err{background:rgba(229,83,75,.12);color:var(--red);display:flex;border:1px solid rgba(229,83,75,.2)}

/* ── Toast ────────────────────────────────────────────────────────────── */
#toast-root{
  position:fixed;bottom:20px;right:20px;z-index:9999;
  display:flex;flex-direction:column;gap:8px;pointer-events:none;
}
.toast{
  background:var(--panel3);border:1px solid var(--border2);
  border-radius:var(--radius-lg);padding:10px 16px;
  font-size:12px;color:var(--text);
  display:flex;align-items:center;gap:10px;
  min-width:220px;max-width:340px;
  box-shadow:0 8px 30px rgba(0,0,0,.5);
  pointer-events:all;
  animation:toast-in var(--mid) var(--ease) both;
}
.toast.out{animation:toast-out 200ms var(--ease) both}
@keyframes toast-in{from{opacity:0;transform:translateX(20px) scale(.95)}to{opacity:1;transform:none}}
@keyframes toast-out{to{opacity:0;transform:translateX(10px) scale(.95)}}
.toast .t-icon{font-size:16px;flex-shrink:0}
.toast.success .t-icon::before{content:'✓';color:var(--green)}
.toast.error   .t-icon::before{content:'✕';color:var(--red)}
.toast.info    .t-icon::before{content:'ℹ';color:var(--accent)}
.toast.warning .t-icon::before{content:'⚠';color:var(--yellow2)}
.toast .t-msg{flex:1}

/* ── Modal / dialog ───────────────────────────────────────────────────── */
.modal-bg{
  position:fixed;inset:0;background:rgba(0,0,0,.6);
  backdrop-filter:blur(4px);z-index:900;
  display:flex;align-items:center;justify-content:center;
  animation:fade-in 150ms ease both;
}
.modal-bg.out{animation:fade-out 150ms ease both}
@keyframes fade-in{from{opacity:0}to{opacity:1}}
@keyframes fade-out{to{opacity:0}}
.modal{
  background:var(--panel2);border:1px solid var(--border2);
  border-radius:var(--radius-xl);padding:24px;
  min-width:300px;max-width:440px;width:90%;
  box-shadow:0 20px 60px rgba(0,0,0,.6);
  animation:modal-in 200ms var(--ease) both;
}
.modal-bg.out .modal{animation:modal-out 150ms var(--ease) both}
@keyframes modal-in{from{opacity:0;transform:translateY(-10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes modal-out{to{opacity:0;transform:translateY(-6px) scale(.97)}}
.modal h3{font-size:14px;font-weight:600;margin-bottom:8px;color:var(--text)}
.modal p{font-size:12px;color:var(--text2);margin-bottom:18px;line-height:1.55}
.modal-actions{display:flex;justify-content:flex-end;gap:8px}

/* ── Misc ─────────────────────────────────────────────────────────────── */
.empty{color:var(--muted);font-size:12px;padding:24px;text-align:center;opacity:.7}
.spinner{
  display:inline-block;width:16px;height:16px;
  border:2px solid var(--border2);border-top-color:var(--accent);
  border-radius:50%;animation:spin .7s linear infinite;
}
.spinner-lg{width:28px;height:28px;border-width:3px}
@keyframes spin{to{transform:rotate(360deg)}}
.skeleton{
  background:linear-gradient(90deg,var(--panel) 25%,var(--panel2) 50%,var(--panel) 75%);
  background-size:400% 100%;
  border-radius:var(--radius);
  animation:shimmer 1.6s linear infinite;
}
@keyframes shimmer{to{background-position:-400% 0}}
h2.page-h{font-size:16px;font-weight:600;color:var(--text)}
h3.section-h{font-size:12px;font-weight:600;color:var(--text2);margin-bottom:10px}
.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:500;background:var(--panel3);color:var(--text2);border:1px solid var(--border)}
hr.sep{border:none;border-top:1px solid var(--border);margin:18px 0}
`;
