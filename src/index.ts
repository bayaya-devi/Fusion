export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  DB: D1Database;
  APP_ENV: string;
  APP_NAME: string;
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;
}

type User = { id: string; email: string; display_name: string; is_verified: number };
type Conversation = { id: string; title: string; created_at: string; updated_at: string };
type ChatMessage = { role: "user" | "assistant"; content: string };

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers });

const error = (message: string, status = 400) => json({ error: message }, status);

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let text = "";
  bytes.forEach((byte) => { text += String.fromCharCode(byte); });
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64Url(new Uint8Array(hash));
}

async function passwordHash(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const saltValue = salt ?? newToken();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(saltValue), iterations: 150_000 },
    key,
    256,
  );
  return { hash: base64Url(new Uint8Array(bits)), salt: saltValue };
}

function expiry(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(): string {
  return cookie("fusion_session", "", 0);
}

async function requestJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown>, field: string, max = 10_000): string | null {
  const value = body[field];
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= max ? cleaned : null;
}

function readCookie(request: Request, name: string): string | null {
  const found = request.headers.get("Cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = readCookie(request, "fusion_session");
  if (!token) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare(`SELECT u.id, u.email, u.display_name, u.is_verified
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP`)
    .bind(tokenHash).first<User>();
}

async function sendVerificationEmail(env: Env, email: string, url: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: `Confirmez votre adresse e-mail — ${env.APP_NAME}`,
      html: `<main style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h1>Bienvenue sur ${env.APP_NAME}</h1><p>Confirmez votre adresse e-mail pour activer votre compte.</p><p><a href="${url}" style="display:inline-block;padding:12px 18px;background:#6855ff;color:#fff;border-radius:8px;text-decoration:none">Confirmer mon e-mail</a></p><p>Ce lien expire dans 24 heures.</p></main>`,
    }),
  });
  if (!response.ok) {
    console.error(JSON.stringify({ event: "verification_email_failed", status: response.status }));
  }
  return response.ok;
}

async function issueVerification(request: Request, env: Env, user: User): Promise<{ url: string; sent: boolean }> {
  const token = newToken();
  const tokenHash = await sha256(token);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_verifications WHERE user_id = ?").bind(user.id),
    env.DB.prepare("INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), user.id, tokenHash, expiry(24)),
  ]);
  const url = new URL("/api/auth/verify", request.url);
  url.searchParams.set("token", token);
  const sent = await sendVerificationEmail(env, user.email, url.toString());
  return { url: url.toString(), sent };
}

async function requireUser(request: Request, env: Env): Promise<User | Response> {
  return (await currentUser(request, env)) ?? error("Connectez-vous pour continuer.", 401);
}

function isResponse(value: User | Response): value is Response { return value instanceof Response; }

async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") return json({ ok: true, app: env.APP_NAME });

  if (path === "/api/auth/register" && method === "POST") {
    const body = await requestJson(request);
    if (!body) return error("Données invalides.");
    const email = stringField(body, "email", 254)?.toLowerCase();
    const displayName = stringField(body, "displayName", 80);
    const password = stringField(body, "password", 200);
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !displayName || !password || password.length < 8) {
      return error("Saisissez un nom, une adresse e-mail valide et un mot de passe de 8 caractères minimum.");
    }
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return error("Cette adresse e-mail est déjà utilisée.", 409);
    const credentials = await passwordHash(password);
    const user: User = { id: crypto.randomUUID(), email, display_name: displayName, is_verified: 0 };
    await env.DB.prepare("INSERT INTO users (id, email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, email, displayName, credentials.hash, credentials.salt).run();
    const verification = await issueVerification(request, env, user);
    const payload: Record<string, unknown> = { message: "Compte créé. Consultez votre boîte e-mail pour le confirmer.", emailSent: verification.sent };
    if (env.APP_ENV !== "production" && !verification.sent) payload.developmentConfirmationUrl = verification.url;
    return json(payload, 201);
  }

  if (path === "/api/auth/resend" && method === "POST") {
    const body = await requestJson(request);
    const email = body ? stringField(body, "email", 254)?.toLowerCase() : null;
    if (!email) return error("Adresse e-mail invalide.");
    const user = await env.DB.prepare("SELECT id, email, display_name, is_verified FROM users WHERE email = ?").bind(email).first<User>();
    if (user && !user.is_verified) {
      const verification = await issueVerification(request, env, user);
      const payload: Record<string, unknown> = { message: "Si un compte attend confirmation, un nouvel e-mail a été envoyé." };
      if (env.APP_ENV !== "production" && !verification.sent) payload.developmentConfirmationUrl = verification.url;
      return json(payload);
    }
    return json({ message: "Si un compte attend confirmation, un nouvel e-mail a été envoyé." });
  }

  if (path === "/api/auth/verify" && method === "GET") {
    const token = url.searchParams.get("token");
    if (!token) return error("Lien de confirmation invalide.");
    const verification = await env.DB.prepare("SELECT user_id FROM email_verifications WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP")
      .bind(await sha256(token)).first<{ user_id: string }>();
    if (!verification) return error("Ce lien est invalide ou a expiré.", 410);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET is_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(verification.user_id),
      env.DB.prepare("DELETE FROM email_verifications WHERE user_id = ?").bind(verification.user_id),
    ]);
    return Response.redirect(new URL("/?verified=1", request.url).toString(), 302);
  }

  if (path === "/api/auth/login" && method === "POST") {
    const body = await requestJson(request);
    const email = body ? stringField(body, "email", 254)?.toLowerCase() : null;
    const password = body ? stringField(body, "password", 200) : null;
    if (!email || !password) return error("Adresse e-mail ou mot de passe invalide.", 401);
    const account = await env.DB.prepare("SELECT id, email, display_name, password_hash, password_salt, is_verified FROM users WHERE email = ?")
      .bind(email).first<User & { password_hash: string; password_salt: string }>();
    if (!account) return error("Adresse e-mail ou mot de passe invalide.", 401);
    const candidate = await passwordHash(password, account.password_salt);
    if (candidate.hash !== account.password_hash) return error("Adresse e-mail ou mot de passe invalide.", 401);
    if (!account.is_verified) return error("Confirmez votre adresse e-mail avant de vous connecter.", 403);
    const token = newToken();
    await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), account.id, await sha256(token), expiry(24 * 14)).run();
    return json({ user: { id: account.id, email: account.email, displayName: account.display_name } }, 200, { "Set-Cookie": cookie("fusion_session", token, 1_209_600) });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = readCookie(request, "fusion_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  if (path === "/api/me") {
    const user = await requireUser(request, env);
    if (isResponse(user)) return user;
    if (method === "GET") return json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
    if (method === "PATCH") {
      const body = await requestJson(request);
      const displayName = body ? stringField(body, "displayName", 80) : null;
      if (!displayName) return error("Nom invalide.");
      await env.DB.prepare("UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(displayName, user.id).run();
      return json({ user: { id: user.id, email: user.email, displayName } });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
      return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
    }
  }

  if (path === "/api/conversations" && method === "GET") {
    const user = await requireUser(request, env);
    if (isResponse(user)) return user;
    const result = await env.DB.prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC")
      .bind(user.id).all<Conversation>();
    return json({ conversations: result.results });
  }

  if (path === "/api/conversations" && method === "POST") {
    const user = await requireUser(request, env);
    if (isResponse(user)) return user;
    const body = await requestJson(request);
    const title = body ? stringField(body, "title", 120) : null;
    const conversation: Conversation = { id: crypto.randomUUID(), title: title ?? "Nouvelle conversation", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await env.DB.prepare("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)").bind(conversation.id, user.id, conversation.title).run();
    return json({ conversation }, 201);
  }

  const conversationMatch = path.match(/^\/api\/conversations\/([\w-]+)(?:\/messages)?$/);
  if (conversationMatch) {
    const user = await requireUser(request, env);
    if (isResponse(user)) return user;
    const conversationId = conversationMatch[1];
    const conversation = await env.DB.prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?")
      .bind(conversationId, user.id).first<Conversation>();
    if (!conversation) return error("Conversation introuvable.", 404);
    const hasMessages = path.endsWith("/messages");
    if (hasMessages && method === "GET") {
      const results = await env.DB.prepare("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .bind(conversationId).all();
      return json({ conversation, messages: results.results });
    }
    if (hasMessages && method === "POST") {
      const body = await requestJson(request);
      const content = body ? stringField(body, "content", 4_000) : null;
      if (!content) return error("Votre message est vide ou trop long.");
      const userMessageId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)").bind(userMessageId, conversationId, content),
        env.DB.prepare("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP, title = CASE WHEN title = 'Nouvelle conversation' THEN ? ELSE title END WHERE id = ?")
          .bind(content.slice(0, 60), conversationId),
      ]);
      const history = await env.DB.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 12")
        .bind(conversationId).all<ChatMessage>();
      const messages: ChatMessage[] = [
        { role: "assistant", content: "Tu es Fusion, un assistant utile, précis et francophone. Réponds avec clarté." },
        ...history.results.reverse(),
      ];
      try {
        const result = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", { messages, max_tokens: 700, temperature: 0.7 });
        const answer = result.response?.trim() || "Je n'ai pas pu générer une réponse. Réessayez dans un instant.";
        const assistantMessage = { id: crypto.randomUUID(), role: "assistant", content: answer, created_at: new Date().toISOString() };
        await env.DB.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)")
          .bind(assistantMessage.id, conversationId, answer).run();
        return json({ message: assistantMessage });
      } catch (cause) {
        console.error(JSON.stringify({ event: "ai_generation_failed", cause: cause instanceof Error ? cause.message : "unknown" }));
        return error("Le modèle est momentanément indisponible. Réessayez dans un instant.", 503);
      }
    }
    if (!hasMessages && method === "PATCH") {
      const body = await requestJson(request);
      const title = body ? stringField(body, "title", 120) : null;
      if (!title) return error("Titre invalide.");
      await env.DB.prepare("UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(title, conversationId).run();
      return json({ conversation: { ...conversation, title } });
    }
    if (!hasMessages && method === "DELETE") {
      await env.DB.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").bind(conversationId, user.id).run();
      return json({ ok: true });
    }
  }
  return error("Route introuvable.", 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
