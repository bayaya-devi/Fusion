const state = { user: null, conversations: [], activeId: null, guest: false };
const $ = (selector) => document.querySelector(selector);
const alertBox = $("#alert");

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const contentType = response.headers.get("Content-Type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || "Une erreur est survenue.");
  return data;
}

function showAlert(message, type = "success") {
  alertBox.textContent = message;
  alertBox.className = `alert ${type}`;
}
function clearAlert() { alertBox.className = ""; alertBox.textContent = ""; }
function showApp(isLoggedIn) { $("#auth-view").classList.toggle("hidden", isLoggedIn); $("#chat-view").classList.toggle("hidden", !isLoggedIn); $("#guest-notice").classList.toggle("hidden", !state.guest); document.body.classList.toggle("guest-mode", state.guest); }

function enterGuestMode() {
  state.guest = true; state.user = { displayName: "visiteur", email: "" }; state.activeId = null; state.conversations = [];
  showApp(true); $("#user-name").textContent = "visiteur"; $("#profile-button").textContent = "Créer un compte"; $("#chat-title").textContent = "Mode découverte"; resetMessages();
}

function setTab(tab) {
  document.querySelectorAll("#auth-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $("#login-form").classList.toggle("hidden", tab !== "login");
  $("#register-form").classList.toggle("hidden", tab !== "register");
  clearAlert();
}

function escapeHtml(text) {
  const div = document.createElement("div"); div.textContent = text; return div.innerHTML;
}

function renderConversations() {
  const list = $("#conversation-list");
  list.innerHTML = state.conversations.map((chat) => `<button class="conversation ${chat.id === state.activeId ? "selected" : ""}" data-id="${chat.id}">${escapeHtml(chat.title)}</button>`).join("");
  list.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => openConversation(button.dataset.id)));
}

function renderMessage(message) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  article.innerHTML = `<div class="avatar">${message.role === "assistant" ? "✦" : state.user.displayName.slice(0, 1).toUpperCase()}</div><div class="bubble">${escapeHtml(message.content).replaceAll("\n", "<br>")}</div>`;
  $("#messages").append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function resetMessages() {
  $("#messages").innerHTML = `<div class="welcome"><div class="spark">✦</div><h1>Bonjour, <span>${escapeHtml(state.user.displayName)}</span></h1><p>Que pouvons-nous créer aujourd’hui ?</p></div>`;
}

async function loadConversations() {
  const data = await request("/api/conversations");
  state.conversations = data.conversations;
  renderConversations();
}

async function newConversation() {
  if (state.guest) { state.activeId = null; $("#chat-title").textContent = "Mode découverte"; resetMessages(); $("#message-input").focus(); return; }
  const { conversation } = await request("/api/conversations", { method: "POST", body: JSON.stringify({}) });
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  renderConversations(); resetMessages(); $("#chat-title").textContent = conversation.title; $("#message-input").focus();
}

async function openConversation(id) {
  const data = await request(`/api/conversations/${id}/messages`);
  state.activeId = id;
  $("#chat-title").textContent = data.conversation.title;
  $("#messages").innerHTML = "";
  data.messages.forEach(renderMessage);
  if (!data.messages.length) resetMessages();
  renderConversations();
}

async function sendMessage(content) {
  if (state.guest) {
    $(".welcome")?.remove(); renderMessage({ role: "user", content });
    const sending = document.createElement("article"); sending.className = "message assistant pending"; sending.innerHTML = `<div class="avatar">✦</div><div class="bubble">Fusion réfléchit<span class="dots">…</span></div>`; $("#messages").append(sending);
    try { const { message } = await request("/api/guest/chat", { method: "POST", body: JSON.stringify({ content }) }); sending.remove(); renderMessage(message); } catch (err) { sending.remove(); renderMessage({ role: "assistant", content: err.message }); }
    return;
  }
  if (!state.activeId) await newConversation();
  $(".welcome")?.remove();
  renderMessage({ role: "user", content });
  const sending = document.createElement("article"); sending.className = "message assistant pending"; sending.innerHTML = `<div class="avatar">✦</div><div class="bubble">Fusion réfléchit<span class="dots">…</span></div>`; $("#messages").append(sending);
  try {
    const { message } = await request(`/api/conversations/${state.activeId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
    sending.remove(); renderMessage(message); await loadConversations();
    const current = state.conversations.find((item) => item.id === state.activeId); if (current) $("#chat-title").textContent = current.title;
  } catch (err) { sending.remove(); renderMessage({ role: "assistant", content: err.message }); }
}

async function initialise() {
  const verified = new URLSearchParams(location.search).get("verified");
  try {
    const { user } = await request("/api/me");
    state.guest = false; state.user = user; showApp(true); $("#user-name").textContent = user.displayName; $("#profile-button").textContent = user.displayName; await loadConversations();
    if (state.conversations.length) await openConversation(state.conversations[0].id); else resetMessages();
  } catch { enterGuestMode(); if (verified) { state.guest = false; showApp(false); showAlert("Adresse e-mail confirmée. Vous pouvez maintenant vous connecter."); } }
}

document.querySelectorAll("#auth-tabs button").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
$("#login-form").addEventListener("submit", async (event) => { event.preventDefault(); clearAlert(); const form = new FormData(event.currentTarget); try { await request("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); await initialise(); } catch (err) { showAlert(err.message, "error"); } });
$("#register-form").addEventListener("submit", async (event) => { event.preventDefault(); clearAlert(); const form = new FormData(event.currentTarget); try { const data = await request("/api/auth/register", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); showAlert(data.developmentConfirmationUrl ? `${data.message} Lien de test : ${data.developmentConfirmationUrl}` : data.message); setTab("login"); } catch (err) { showAlert(err.message, "error"); } });
$("#resend-button").addEventListener("click", async () => { const email = $("#login-form [name=email]").value; if (!email) return showAlert("Saisissez votre e-mail, puis réessayez.", "error"); try { const data = await request("/api/auth/resend", { method: "POST", body: JSON.stringify({ email }) }); showAlert(data.developmentConfirmationUrl ? `${data.message} Lien de test : ${data.developmentConfirmationUrl}` : data.message); } catch (err) { showAlert(err.message, "error"); } });
$("#guest-button").addEventListener("click", enterGuestMode);
$("#guest-signin").addEventListener("click", () => { state.guest = false; showApp(false); setTab("login"); });
$("#new-chat").addEventListener("click", newConversation);
$("#message-form").addEventListener("submit", async (event) => { event.preventDefault(); const input = $("#message-input"); const content = input.value.trim(); if (!content) return; input.value = ""; input.style.height = "auto"; await sendMessage(content); });
$("#message-input").addEventListener("input", (event) => { event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 160)}px`; });
$("#logout-button").addEventListener("click", async () => { if (state.guest) return location.assign("/"); await request("/api/auth/logout", { method: "POST" }); location.href = "/"; });
$("#delete-chat").addEventListener("click", async () => { if (!state.activeId || !confirm("Supprimer cette conversation ?")) return; await request(`/api/conversations/${state.activeId}`, { method: "DELETE" }); state.activeId = null; await loadConversations(); if (state.conversations.length) openConversation(state.conversations[0].id); else { $("#chat-title").textContent = "Nouvelle conversation"; resetMessages(); } });
$("#profile-button").addEventListener("click", () => { if (state.guest) { state.guest = false; showApp(false); setTab("register"); return; } $("#profile-name").value = state.user.displayName; $("#profile-email").value = state.user.email; $("#profile-dialog").showModal(); });
$("#profile-form").addEventListener("submit", async (event) => { event.preventDefault(); const displayName = $("#profile-name").value; try { const { user } = await request("/api/me", { method: "PATCH", body: JSON.stringify({ displayName }) }); state.user = user; $("#user-name").textContent = user.displayName; $("#profile-button").textContent = user.displayName; $("#profile-dialog").close(); } catch (err) { alert(err.message); } });
$("#delete-account").addEventListener("click", async () => { if (!confirm("Supprimer définitivement votre compte et vos conversations ?")) return; await request("/api/me", { method: "DELETE" }); location.href = "/"; });
initialise();
