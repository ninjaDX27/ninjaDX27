// Chamada de teste no browser: fala o protocolo do Twilio ConversationRelay
// (setup / prompt / interrupt -> text / language / end), por isso o servidor
// trata-a exatamente como uma chamada telefónica.
(function () {
  var root = document.getElementById("call");
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var log = $("call-log"), statusEl = $("call-status"), startBtn = $("call-start"), endBtn = $("call-end");
  var stopBtn = $("call-stop-speaking"), typeForm = $("call-type"), typeInput = $("call-text"), sendBtn = $("call-send");

  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var canSpeak = "speechSynthesis" in window;
  if (!Recognition) $("call-support").textContent = "Este browser não reconhece voz. Pode escrever as mensagens, ou abrir esta página no Chrome ou no Edge.";

  var ws = null, rec = null, lang = "pt-PT", active = false, listening = false;
  var agentBubble = null, agentText = "", spokenText = "", pendingSentences = "", responseDone = true, speakingCount = 0;

  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = "badge" + (cls ? " " + cls : ""); }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function bubble(cls, text) {
    var empty = $("call-empty"); if (empty) empty.remove();
    var el = document.createElement("div");
    el.className = "msg " + cls;
    el.textContent = text;
    log.appendChild(el); scroll();
    return el;
  }

  // ---------- Voz do assistente (síntese do browser), frase a frase para começar mais cedo
  function pickVoice(l) {
    var voices = canSpeak ? speechSynthesis.getVoices() : [];
    var exact = voices.filter(function (v) { return v.lang === l || v.lang.replace("_", "-") === l; });
    var natural = exact.filter(function (v) { return /natural|online/i.test(v.name); });
    return natural[0] || exact[0] || voices.filter(function (v) { return v.lang.slice(0, 2) === l.slice(0, 2); })[0] || null;
  }
  function speak(text) {
    if (!canSpeak || !text.trim()) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    var v = pickVoice(lang); if (v) u.voice = v;
    speakingCount++;
    stopBtn.hidden = false;
    u.onend = u.onerror = function () {
      spokenText += text + " ";
      speakingCount = Math.max(0, speakingCount - 1);
      afterSpeech();
    };
    speechSynthesis.speak(u);
  }
  function flushSentences(force) {
    var re = /^([\s\S]*?[.!?…])(\s+|$)/, m;
    while ((m = re.exec(pendingSentences)) && (m[2] || force)) {
      speak(m[1]);
      pendingSentences = pendingSentences.slice(m[0].length);
    }
    if (force && pendingSentences.trim()) { speak(pendingSentences); pendingSentences = ""; }
  }
  function afterSpeech() {
    if (speakingCount === 0) {
      stopBtn.hidden = true;
      if (responseDone && active) listen();
    }
  }

  // ---------- Microfone
  function listen() {
    if (!Recognition || !active || listening || speakingCount > 0) { if (active && !listening) setStatus("Em linha", "live"); return; }
    rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    var interim = null, finalText = "";
    rec.onresult = function (e) {
      var text = "";
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else text += e.results[i][0].transcript;
      }
      if (!interim) interim = bubble("caller pending", "");
      interim.textContent = (finalText + " " + text).trim();
      scroll();
    };
    rec.onerror = function (e) {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        $("call-support").textContent = "O microfone foi bloqueado. Autorize-o na barra de endereço ou escreva as mensagens.";
      }
    };
    rec.onend = function () {
      listening = false;
      if (interim && !finalText.trim()) interim.remove();
      if (finalText.trim()) { interim.className = "msg caller"; send(finalText.trim(), true); }
      else if (active && responseDone && speakingCount === 0) setTimeout(listen, 250);
    };
    try { rec.start(); listening = true; setStatus("A ouvir…", "listening"); } catch (_) { listening = false; }
  }
  function stopListening() { if (rec && listening) { try { rec.abort(); } catch (_) {} } listening = false; }

  // ---------- Protocolo
  function send(text, alreadyShown) {
    if (!ws || ws.readyState !== 1 || !text) return;
    if (!alreadyShown) bubble("caller", text);
    stopListening();
    agentBubble = null; agentText = ""; responseDone = false; pendingSentences = "";
    setStatus("A pensar…", "live");
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: text, last: true, lang: lang }));
  }

  function onMessage(ev) {
    var m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === "text") {
      if (m.token) {
        if (!agentBubble) { agentBubble = bubble("agent", ""); setStatus("A falar…", "live"); }
        agentText += m.token; agentBubble.textContent = agentText; scroll();
        pendingSentences += m.token; flushSentences(false);
      }
      if (m.last) { responseDone = true; flushSentences(true); afterSpeech(); }
    } else if (m.type === "language" && m.ttsLanguage) {
      lang = m.ttsLanguage;
      bubble("system", "Idioma alterado para " + lang);
    } else if (m.type === "end") {
      var data = {}; try { data = JSON.parse(m.handoffData || "{}"); } catch (_) {}
      var why = data.action === "transfer" ? "O assistente transferiu a chamada para a receção." : "O assistente terminou a chamada.";
      responseDone = true; flushSentences(true);
      bubble("system", why);
      finish(false);
    }
  }

  function start() {
    startBtn.disabled = true;
    setStatus("A ligar…");
    var body = new URLSearchParams({ _csrf: root.getAttribute("data-csrf") || "" });
    fetch("/app/testar", { method: "POST", body: body, credentials: "same-origin", headers: { "content-type": "application/x-www-form-urlencoded" } })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Erro " + r.status); return j; }); })
      .then(function (c) {
        lang = c.language;
        ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + c.path);
        ws.onopen = function () {
          ws.send(JSON.stringify({ type: "setup", callSid: c.callSid }));
          active = true;
          startBtn.hidden = true; endBtn.hidden = false; typeInput.disabled = false; sendBtn.disabled = false;
          log.innerHTML = "";
          bubble("agent", c.greeting);
          responseDone = true; speak(c.greeting); afterSpeech();
          if (!canSpeak) listen();
        };
        ws.onmessage = onMessage;
        ws.onclose = function () { if (active) { bubble("system", "Chamada terminada."); finish(true); } };
      })
      .catch(function (e) { setStatus("Erro"); $("call-support").textContent = e.message; startBtn.disabled = false; });
  }

  function finish(closed) {
    active = false; stopListening();
    if (!closed && ws) { try { ws.close(); } catch (_) {} }
    ws = null;
    setTimeout(function () { if (!active && canSpeak && speakingCount === 0) speechSynthesis.cancel(); }, 15000);
    setStatus("Terminada");
    endBtn.hidden = true; stopBtn.hidden = true; startBtn.hidden = false; startBtn.disabled = false; startBtn.textContent = "Nova chamada";
    typeInput.disabled = true; sendBtn.disabled = true;
  }

  startBtn.addEventListener("click", start);
  endBtn.addEventListener("click", function () { if (canSpeak) speechSynthesis.cancel(); speakingCount = 0; bubble("system", "Desligou a chamada."); finish(false); });
  stopBtn.addEventListener("click", function () {
    if (!ws) return;
    if (canSpeak) speechSynthesis.cancel();
    pendingSentences = ""; speakingCount = 0;
    ws.send(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: spokenText.trim().slice(-500) }));
    responseDone = true; stopBtn.hidden = true; listen();
  });
  typeForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = typeInput.value.trim(); if (!text) return;
    typeInput.value = "";
    if (canSpeak) speechSynthesis.cancel(); speakingCount = 0;
    send(text, false);
  });
  if (canSpeak) speechSynthesis.getVoices();
})();
