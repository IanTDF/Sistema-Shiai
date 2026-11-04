// ============================================================
// auth.js — login (Firebase Auth, e-mail/senha) e perfil do usuário.
//
// Uso em cada página protegida (depois do firebase-config.js):
//   <script src="auth.js" data-papeis="admin"></script>
//   <script src="auth.js" data-papeis="admin,mesario"></script>
//
// Enquanto não houver um usuário com perfil permitido, uma tela
// cobre a página inteira. O perfil vem de usuarios/{uid}.papel
// ("admin" ou "mesario"). A segurança real está em firestore.rules;
// esta tela só organiza o acesso.
// ============================================================
(function () {
  const PAPEIS = (document.currentScript.dataset.papeis || "admin,mesario")
    .split(",").map(s => s.trim());
  const NOMES = { admin: "Administrador", mesario: "Mesário" };
  const auth = firebase.auth();
  window.usuarioAtual = null;

  let mensagemPendente = "";

  // ---------- estilo (mesma identidade das demais telas) ----------
  const estilo = document.createElement("style");
  estilo.textContent = `
    #authOverlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center;
      justify-content: center; padding: 16px; background: #f3f5f1; color: #0f2a4d;
      font-family: "Barlow", "Segoe UI", Arial, sans-serif; }
    #authOverlay[hidden] { display: none; }
    #authOverlay .cx { width: 100%; max-width: 380px; padding: 20px 22px 22px; background: #fff;
      border: 2px solid #cfd6cb; border-radius: 6px; }
    #authOverlay h1 { margin: 0 0 14px; padding-bottom: 4px; font-family: "Barlow Condensed", "Barlow", sans-serif;
      font-size: 26px; color: #0f5128; border-bottom: 3px solid #1c7a3f; }
    #authOverlay label { display: block; margin: 0 0 4px; font-size: 15px; font-weight: 600; }
    #authOverlay input { width: 100%; margin-bottom: 12px; padding: 9px 12px; border: 2px solid #cfd6cb;
      border-radius: 6px; font: inherit; font-size: 16px; color: #0f2a4d; box-sizing: border-box; }
    #authOverlay input:focus { outline: none; border-color: #0f2a4d; }
    #authOverlay button, #authBar button { padding: 10px 16px; border: 2px solid #0f2a4d; border-radius: 6px;
      background: #0f2a4d; color: #fff; font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; }
    #authOverlay button { width: 100%; }
    #authOverlay button:disabled { opacity: .6; cursor: default; }
    #authOverlay button:focus-visible, #authBar button:focus-visible { outline: 3px solid #e0a800; outline-offset: 2px; }
    #authOverlay .erro { margin: 0 0 12px; font-size: 15px; font-weight: 600; color: #b3261e; }
    #authOverlay .txt { margin: 0 0 12px; font-size: 16px; color: #5c685a; }
    #authBar { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px 12px;
      margin: 0 0 12px; font-family: "Barlow", "Segoe UI", Arial, sans-serif; font-size: 14px; color: #0f2a4d; }
    #authBar button { padding: 5px 12px; font-size: 14px; background: #fff; color: #0f2a4d; }
    #authBar select { padding: 4px 6px; font: inherit; border: 2px solid #cfd6cb; border-radius: 6px; }
  `;
  document.head.appendChild(estilo);

  const overlay = document.createElement("div");
  overlay.id = "authOverlay";
  document.body.appendChild(overlay);

  function esc(t) {
    return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function tela(titulo, corpo) {
    overlay.hidden = false;
    overlay.innerHTML = `<div class="cx"><h1>${titulo}</h1>${corpo}</div>`;
  }

  function mostrarCarregando(txt) {
    tela("Sistema Sensei", `<p class="txt">${esc(txt || "Verificando acesso...")}</p>`);
  }

  function mostrarLogin() {
    tela("Entrar", `
      ${mensagemPendente ? `<p class="erro" role="alert">${esc(mensagemPendente)}</p>` : ""}
      <form id="authForm">
        <label for="authEmail">E-mail</label>
        <input id="authEmail" type="email" autocomplete="username" required>
        <label for="authSenha">Senha</label>
        <input id="authSenha" type="password" autocomplete="current-password" required>
        <button type="submit" id="authEntrar">Entrar</button>
      </form>`);
    mensagemPendente = "";

    document.getElementById("authForm").addEventListener("submit", async ev => {
      ev.preventDefault();
      let btn = document.getElementById("authEntrar");
      btn.disabled = true;
      btn.textContent = "Entrando...";
      try {
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); // mantém a sessão
        await auth.signInWithEmailAndPassword(
          document.getElementById("authEmail").value.trim(),
          document.getElementById("authSenha").value
        );
        // o restante é feito em onAuthStateChanged
      } catch (e) {
        mensagemPendente = traduzirErro(e);
        mostrarLogin();
      }
    });
  }

  function traduzirErro(e) {
    switch (e && e.code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
      case "auth/invalid-email": return "E-mail ou senha incorretos.";
      case "auth/too-many-requests": return "Muitas tentativas. Aguarde um pouco e tente de novo.";
      case "auth/network-request-failed": return "Sem conexão com a internet.";
      case "auth/user-disabled": return "Este usuário está desativado.";
      default: return "Não foi possível entrar (" + ((e && e.code) || "erro") + ").";
    }
  }

  function removerBarra() {
    let b = document.getElementById("authBar");
    if (b) b.remove();
  }

  function mostrarBarra(user, papel) {
    removerBarra();
    let bar = document.createElement("div");
    bar.id = "authBar";
    bar.innerHTML = `<span>👤 <b>${esc(user.email)}</b> · ${NOMES[papel]}</span>
      <span id="authAreaSel"></span>
      <button type="button" id="authSair">Sair</button>`;
    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById("authSair").onclick = () => auth.signOut();

    // Na tela de área: seletor para trocar de área (o ?area=N continua valendo)
    if (/area\.html$/.test(location.pathname)) {
      window.addEventListener("load", () => {
        if (typeof iniciarStore !== "function") return;
        iniciarStore().then(() => {
          let atual = new URLSearchParams(location.search).get("area");
          let ids = getAreas().map(a => a.id);
          if (!ids.length) return;
          document.getElementById("authAreaSel").innerHTML =
            `<label>Área <select id="authAreaSelect">${ids.map(i =>
              `<option value="${i}"${String(i) === atual ? " selected" : ""}>${i}</option>`).join("")}</select></label>`;
          document.getElementById("authAreaSelect").onchange = ev => {
            location.href = "area.html?area=" + ev.target.value;
          };
        });
      });
    }
  }

  function paginaInicial(papel) {
    return papel === "admin" ? "categorias.html" : "area.html?area=1";
  }

  mostrarCarregando();

  auth.onAuthStateChanged(async user => {
    window.usuarioAtual = null;

    if (!user) {
      removerBarra();
      mostrarLogin();
      return;
    }

    mostrarCarregando();

    let papel = null;
    try {
      let snap = await db.collection("usuarios").doc(user.uid).get();
      papel = snap.exists ? snap.data().papel : null;
    } catch (e) {
      console.error("Erro ao ler o perfil:", e);
      tela("Erro", `<p class="erro" role="alert">Não foi possível ler o seu perfil (${esc(e.code || e.message)}).</p>
        <button type="button" onclick="location.reload()">Tentar de novo</button>`);
      return;
    }

    if (!NOMES[papel]) {
      mensagemPendente = "Este usuário não tem perfil cadastrado. Fale com o administrador.";
      await auth.signOut(); // dispara onAuthStateChanged e mostra o login com a mensagem
      return;
    }

    window.usuarioAtual = { uid: user.uid, email: user.email, papel };

    if (!PAPEIS.includes(papel)) {
      // perfil válido, mas sem acesso a esta página: leva para a página dele
      mostrarCarregando("Sem acesso a esta página. Redirecionando...");
      location.replace(paginaInicial(papel));
      return;
    }

    overlay.hidden = true;
    overlay.innerHTML = "";
    mostrarBarra(user, papel);
  });
})();
