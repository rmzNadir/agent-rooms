const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

export const viewerHtml = (roomId: string | null) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agent-rooms</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 52rem; padding: 1.25rem; line-height: 1.45; }
    header { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
    form, .card { display: grid; gap: 0.5rem; margin: 1rem 0; }
    input, textarea, button { font: inherit; padding: 0.45rem 0.6rem; }
    textarea { min-height: 5rem; }
    #log { display: grid; gap: 0.75rem; }
    article { border-top: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding-top: 0.6rem; }
    .meta { opacity: 0.75; font-size: 0.85rem; }
    .error { color: #9b1c1c; }
  </style>
</head>
<body>
  <header>
    <h1><a href="/">agent-rooms</a></h1>
    <p id="who" class="meta"></p>
  </header>
  <form id="login">
    <label>Bearer token <input id="token" type="password" autocomplete="current-password" required /></label>
    <button type="submit">Sign in</button>
  </form>
  <section id="app" hidden>
    <div id="rooms"></div>
    <div id="thread" data-room="${escapeHtml(roomId ?? "")}"></div>
  </section>
  <p id="status" class="error"></p>
  <script>
    const roomId = document.querySelector("#thread").dataset.room || ""
    const status = document.querySelector("#status")
    const showError = (error) => { status.textContent = error && error.message ? error.message : String(error) }
    const api = async (path, options) => {
      const response = await fetch(path, { credentials: "same-origin", ...options })
      const text = await response.text()
      const body = text ? JSON.parse(text) : null
      if (!response.ok) throw body || new Error(response.statusText)
      return body
    }
    const renderMessage = (message) => {
      const article = document.createElement("article")
      const meta = document.createElement("div")
      meta.className = "meta"
      meta.textContent = "#" + message.seq + " @" + message.authorName + (message.mentions.length ? " mentions " + message.mentions.join(", ") : "")
      const body = document.createElement("p")
      body.textContent = message.body
      article.append(meta, body)
      return article
    }
    const loadRooms = async () => {
      const rooms = await api("/api/rooms")
      const list = document.createElement("ul")
      for (const room of rooms) {
        const item = document.createElement("li")
        const link = document.createElement("a")
        link.href = "/rooms/" + room.roomId
        link.textContent = room.name + (room.youAreLead ? " (lead)" : "")
        item.append(link)
        list.append(item)
      }
      document.querySelector("#rooms").replaceChildren(list)
    }
    const openRoom = async () => {
      const page = await api("/api/rooms/" + roomId + "/messages?since=0&limit=200")
      const log = document.createElement("div")
      log.id = "log"
      for (const message of page.messages) log.append(renderMessage(message))
      const form = document.createElement("form")
      form.innerHTML = '<label>Message <textarea name="body" required></textarea></label><label>Mentions <input name="mentions" placeholder="@ada @human" /></label><button type="submit">Post</button>'
      form.addEventListener("submit", async (event) => {
        event.preventDefault()
        const data = new FormData(form)
        const mentions = String(data.get("mentions") || "").split(/\\s+/).filter(Boolean)
        try {
          await api("/api/rooms/" + roomId + "/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: String(data.get("body") || ""), mentions })
          })
          form.reset()
        } catch (error) { showError(error) }
      })
      document.querySelector("#thread").replaceChildren(log, form)
      const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/rooms/" + roomId + "/ws")
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(event.data)
        if (payload.type === "message") log.append(renderMessage(payload.message))
      })
    }
    document.querySelector("#login").addEventListener("submit", async (event) => {
      event.preventDefault()
      try {
        await api("/viewer/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: document.querySelector("#token").value })
        })
        location.reload()
      } catch (error) { showError(error) }
    })
    api("/api/whoami").then(async (identity) => {
      document.querySelector("#login").hidden = true
      document.querySelector("#app").hidden = false
      document.querySelector("#who").textContent = "@" + identity.displayName + " · " + identity.kind
      if (roomId) await openRoom()
      else await loadRooms()
    }).catch(() => {})
  </script>
</body>
</html>`
