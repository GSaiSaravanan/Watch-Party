# Watch Party 🎬🍿

A real-time, low-latency collaborative video streaming web app with sub-500ms playback sync, host controls, and interactive chat.

---

## ⚡ Features

* **Real-Time Sync Engine:** Continuous 2s host heartbeat keeps playback drift strictly under 500 ms across all connected clients.


* **Loopback & Autoplay Guard:** Uses an `isRemoteUpdate` ref to prevent WebSocket echo loops and starts guest playback muted to bypass browser autoplay blockers cleanly.


* **Timeline Bookmarks & Guest Peek Mode:**
* Hosts can bookmark scenes on the fly with timestamps and labels.
* Guests can click "Jump to Scene" to inspect moments locally in **Peek Mode** without interrupting the room, then tap **Catch Up to Live** to rejoin the host.
* Bookmarks remember their original `videoId` and switch videos automatically when jumped to.




* **Session-Safe Host Controls:** Token-based host verification prevents tab refreshes from accidentally reassigning host privileges.
* **Shared Movie Queue:** Dynamic queue where participants can add YouTube video IDs/links, and the host can trigger the next video.


* **Live Chat & Floating Reactions:** Real-time chat with timestamps and animated emoji reactions (❤️, 😂, 🍿, 🔥, 👏, 💀, 😮, 🎉) complete with sender tags.
* **Live Diagnostics HUD:** Collapsible drawer reporting Round-Trip Time latency ($\le 250\text{ ms}$), active drift ($\le 500\text{ ms}$), and connected peer count.

---

## 🛠️ Tech Stack

* **Frontend:** React 19, Vite, Tailwind CSS v4


* **Backend:** Node.js, Express, Socket.io


* **Video Engine:** YouTube IFrame Player API


* **State:** Ephemeral in-memory server state



---

## 🚀 Quick Start

### 1. Backend Server

```bash
cd server
npm install
node index.js

```

Runs on `http://localhost:5000`.

### 2. Frontend Client

```bash
cd client
npm install
npm run dev

```

Runs on `http://localhost:5173`.

---

## 🧪 Quick Test Flow

1. Open `http://localhost:5173` in Tab 1 and click **Create Room** (designated as **★ Host**).


2. Copy the invite link and open it in Tab 2 (Incognito/Guest).


3. Press **Play** or scrub the timeline in Tab 1—Tab 2 automatically synchronizes within 500 ms.


4. Test **Bookmark Moment** on Tab 1, jump to it locally in Tab 2 to verify **Peek Mode**, and click **Catch Up to Live ⏩** to return.
