// Melhorias progressivas: os formulários funcionam sem JavaScript.
(function () {
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;

    // Remover um bloco repetível (quarto, política, pergunta).
    if (t.matches("[data-remove]")) {
      var block = t.closest(".repeat");
      if (block) block.remove();
      return;
    }
    // Adicionar um bloco a partir do <template>.
    if (t.matches("[data-add]")) {
      var tpl = document.getElementById(t.getAttribute("data-add"));
      var list = document.getElementById(t.getAttribute("data-into"));
      if (tpl instanceof HTMLTemplateElement && list) {
        var node = tpl.content.cloneNode(true);
        list.appendChild(node);
        var added = list.lastElementChild;
        var first = added && added.querySelector("input, textarea");
        if (first) first.focus();
      }
      return;
    }
    // Copiar um valor (segredo, URL).
    if (t.matches("[data-copy]")) {
      var src = document.getElementById(t.getAttribute("data-copy"));
      if (src && navigator.clipboard) {
        navigator.clipboard.writeText(src.textContent || "").then(function () {
          var old = t.textContent;
          t.textContent = "Copiado";
          setTimeout(function () { t.textContent = old; }, 1500);
        });
      }
    }
  });

  // Evita envios duplicados.
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var btn = form.querySelector("button[type=submit]");
    if (btn) setTimeout(function () { btn.setAttribute("disabled", "disabled"); }, 0);
  });
})();
