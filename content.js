let isLoading = false;

// 🧠 Generate short labels (key feature)
function generateLabel(text) {
  const stopWords = [
    "what","how","should","i","me","can","you","the","is","are",
    "a","an","to","in","on","when","that","this","it","of","for",
    "do","does","did","will","would","could","my"
  ];

  let words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter(word => word && !stopWords.includes(word));

  words = words.slice(0, 5);

  return words
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// 🧠 Extract messages
function getMessages() {
  const nodes = document.querySelectorAll(
    '[data-message-author-role="user"]'
  );

  return Array.from(nodes).map((el, index) => {
    const rawText = el.innerText.split("\n")[0];

    return {
      id: index,
      text: generateLabel(rawText),
      fullText: rawText,
      element: el
    };
  });
}

// 🧠 Fake tree logic
function buildTree(messages) {
  const tree = [];
  let currentParent = null;
  let currentChild = null;

  messages.forEach((msg, i) => {
    const node = { ...msg, children: [] };

    if (i % 5 === 0) {
      currentParent = node;
      currentChild = null;
      tree.push(node);
    } else if (i % 2 === 0 && currentParent) {
      currentChild = node;
      currentParent.children.push(node);
    } else if (currentChild) {
      currentChild.children.push(node);
    } else if (currentParent) {
      currentParent.children.push(node);
    }
  });

  return tree;
}

// 🎨 Render nodes
function renderNode(node, level = 0) {
  const container = document.createElement("div");
  container.className = `tree-node level-${level}`;

  container.innerHTML = `
    <div class="node-content">
      <span class="node-dot ${level === 0 ? "main" : "sub"}"></span>
      <span class="node-text" title="${node.fullText}">
        ${node.text || "Untitled"}
      </span>
    </div>
  `;

  container.onclick = (e) => {
    e.stopPropagation();
    node.element.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  };

  if (node.children.length > 0 && level < 2) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "children";

    node.children.forEach((child) => {
      childrenContainer.appendChild(renderNode(child, level + 1));
    });

    container.appendChild(childrenContainer);
  }

  return container;
}

// 🎨 Sidebar UI
function createSidebar(tree) {
  document.getElementById("chatgpt-sidebar")?.remove();

  const sidebar = document.createElement("div");
  sidebar.id = "chatgpt-sidebar";

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="header-top">
        <div>
          <div class="title">Navigator</div>
          <div class="subtitle">Conversation outline</div>
        </div>
        <div class="header-actions">
          <span class="count">${tree.length}</span>
          <button id="reload-btn">↻</button>
        </div>
      </div>

      <input id="search-input" placeholder="Search blocks..." />
    </div>
  `;

  const list = document.createElement("div");
  list.className = "block-list";

  tree.forEach((node) => {
    list.appendChild(renderNode(node));
  });

  sidebar.appendChild(list);
  document.body.appendChild(sidebar);

  // 🔍 Search
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", (e) => {
    const value = e.target.value.toLowerCase();

    document.querySelectorAll(".tree-node").forEach((nodeEl) => {
      const text = nodeEl.innerText.toLowerCase();
      nodeEl.style.display = text.includes(value) ? "block" : "none";
    });
  });

  // 🔁 Reload
  document.getElementById("reload-btn").onclick = () => init();
}

// 🔘 Toggle
function createToggle() {
  if (document.getElementById("toggle-btn")) return;

  const btn = document.createElement("button");
  btn.innerText = "≡";
  btn.id = "toggle-btn";

  btn.onclick = () => {
    const sidebar = document.getElementById("chatgpt-sidebar");
    if (!sidebar) return;

    sidebar.style.display =
      sidebar.style.display === "none" ? "block" : "none";
  };

  document.body.appendChild(btn);
}

// 🚀 Init
function init() {
  if (isLoading) return;

  isLoading = true;

  setTimeout(() => {
    const messages = getMessages();
    const tree = buildTree(messages);

    createSidebar(tree);
    createToggle();

    isLoading = false;
  }, 500);
}

// 🔄 Detect chat switch
let lastUrl = location.href;

setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    init();
  }
}, 1000);

// 🔥 First load
setTimeout(init, 1500);