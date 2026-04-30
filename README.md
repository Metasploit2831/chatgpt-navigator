# ChatGPT Navigator

A Chrome extension that transforms long AI conversations into a structured, navigable thinking interface.

---

## 🧠 Overview

AI conversations today are powerful—but hard to navigate.

As chats grow longer, users lose:
- Context  
- Structure  
- The ability to revisit key decisions  

**ChatGPT Navigator** solves this by converting conversations into a structured sidebar, allowing users to scan, navigate, and understand their thinking more efficiently.

---

## ✨ Features

- 🌲 **Tree-based Navigation**  
  Converts chat messages into a hierarchical structure for easier exploration  

- ⚡ **Instant Jump-to-Context**  
  Click any node to scroll directly to that part of the conversation  

- 🔍 **Search**  
  Quickly find relevant parts of long chats  

- 🧩 **Smart Label Compression (V1)**  
  Shortens long prompts into scannable labels  

- 🪄 **Lightweight Overlay UI**  
  Injected directly into ChatGPT with no backend required  

---

## 🛠️ Tech Stack

- Vanilla JavaScript (Content Scripts)  
- Chrome Extension APIs (Manifest V3)  
- DOM Parsing & Injection  
- CSS for UI rendering  

---

## ⚙️ How It Works

```text
ChatGPT UI (DOM)
      ↓
Extract User Messages
      ↓
Transform into Structured Nodes
      ↓
Render Sidebar Navigator
