const SIDEBAR_ID = "chatgpt-navigator-sidebar";
const TOGGLE_ID = "chatgpt-navigator-toggle";
const COLLAPSED_KEY = "chatgptNavigatorCollapsed";
const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
const TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"]',
  'article',
  'main [class*="group/conversation-turn"]'
].join(",");
const AI_LABEL_INPUT_LIMIT = 4000;

let isRendering = false;
let renderTimer = null;
let observer = null;
let lastUrl = location.href;
const aiLabelCache = new Map();
let summarizerPromise = null;

function generateLabel(text) {
  const stopWords = new Set([
    "what", "how", "should", "i", "me", "can", "you", "the", "is", "are",
    "a", "an", "to", "in", "on", "when", "that", "this", "it", "of", "for",
    "do", "does", "did", "will", "would", "could", "my", "with", "and"
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .split(/\s+/)
    .filter((word) => word && !stopWords.has(word))
    .slice(0, 6);

  const label = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  return label || "Untitled";
}

function shouldUseAiLabel(text) {
  return text.trim().length > 0 && "Summarizer" in globalThis;
}

function cleanAiLabel(label) {
  return label
    .replace(/^["'`\s-]+|["'`\s.]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 72)
    .trim();
}

async function getSummarizer() {
  if (!("Summarizer" in globalThis)) return null;
  if (summarizerPromise) return summarizerPromise;

  summarizerPromise = (async () => {
    const options = {
      type: "headline",
      format: "plain-text",
      length: "short",
      sharedContext: "Create short navigation labels for ChatGPT conversation messages."
    };

    if (typeof globalThis.Summarizer.availability === "function") {
      const availability = await globalThis.Summarizer.availability(options);
      if (availability === "unavailable") return null;
    }

    if (typeof globalThis.Summarizer.create !== "function") return null;
    return globalThis.Summarizer.create(options);
  })().then((summarizer) => {
    if (!summarizer) summarizerPromise = null;
    return summarizer;
  }).catch(() => {
    summarizerPromise = null;
    return null;
  });

  return summarizerPromise;
}

async function summarizeLabel(text) {
  const summarizer = await getSummarizer();
  if (!summarizer || typeof summarizer.summarize !== "function") return null;

  const summary = await summarizer.summarize(text.slice(0, AI_LABEL_INPUT_LIMIT));
  const label = cleanAiLabel(String(summary || ""));

  return label || null;
}

function queueAiLabel(text, fallbackLabel) {
  const cached = aiLabelCache.get(text);
  if (cached?.status === "ready" || cached?.status === "pending") return;

  aiLabelCache.set(text, {
    label: fallbackLabel,
    source: "rule",
    status: "pending"
  });

  summarizeLabel(text)
    .then((label) => {
      if (!label || label.toLowerCase() === fallbackLabel.toLowerCase()) {
        aiLabelCache.set(text, {
          label: fallbackLabel,
          source: "rule",
          status: "ready"
        });
        return;
      }

      aiLabelCache.set(text, {
        label,
        source: "ai",
        status: "ready"
      });

      scheduleRender(0);
    })
    .catch(() => {
      aiLabelCache.set(text, {
        label: fallbackLabel,
        source: "rule",
        status: "ready"
      });
    });
}

function getLabel(text) {
  const fallbackLabel = generateLabel(text);
  const cached = aiLabelCache.get(text);

  if (cached?.status === "ready") {
    return {
      text: cached.label,
      source: cached.source
    };
  }

  if (shouldUseAiLabel(text)) {
    queueAiLabel(text, fallbackLabel);
  }

  return {
    text: fallbackLabel,
    source: "rule"
  };
}

function getMessageText(element) {
  const text = element.innerText || element.textContent || "";

  return text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function uniqueElements(elements) {
  return Array.from(new Set(elements));
}

function isNavigatorElement(element) {
  return Boolean(element.closest(`#${SIDEBAR_ID}, #${TOGGLE_ID}`));
}

function inferRole(element, index) {
  const roleElement = element.matches("[data-message-author-role]")
    ? element
    : element.querySelector("[data-message-author-role]");
  const role = roleElement?.getAttribute("data-message-author-role");

  if (role === "user" || role === "assistant") return role;

  const text = element.getAttribute("aria-label") || element.dataset.testid || "";
  if (/user|prompt/i.test(text)) return "user";
  if (/assistant|response|answer/i.test(text)) return "assistant";

  return index % 2 === 0 ? "user" : "assistant";
}

function getMessageElements() {
  const roleElements = uniqueElements(Array.from(document.querySelectorAll(ROLE_SELECTOR)))
    .filter((element) => !isNavigatorElement(element) && getMessageText(element));

  if (roleElements.length > 0) return roleElements;

  return uniqueElements(Array.from(document.querySelectorAll(TURN_SELECTOR)))
    .filter((element) => !isNavigatorElement(element) && getMessageText(element));
}

function getMessages() {
  const nodes = getMessageElements();

  return nodes
    .map((element, index) => {
      const fullText = getMessageText(element);
      const role = inferRole(element, index);
      const label = getLabel(fullText);

      return {
        id: index,
        role,
        text: label.text,
        labelSource: label.source,
        fullText,
        element,
        children: []
      };
    })
    .filter((message) => message.fullText);
}

function buildOutline(messages) {
  const outline = [];
  let currentUserNode = null;

  messages.forEach((message) => {
    const node = { ...message, children: [] };

    if (message.role === "user" || !currentUserNode) {
      outline.push(node);
      currentUserNode = node;
      return;
    }

    currentUserNode.children.push(node);
  });

  return outline;
}

function createIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "navigator-icon");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  const paths = {
    refresh: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6",
    panel: "M4 5h16M4 12h16M4 19h16",
    search: "m21 21-4.34-4.34M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z",
    user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
    assistant: "M12 3v3M5.64 5.64l2.12 2.12M3 12h3M5.64 18.36l2.12-2.12M12 18v3M16.24 16.24l2.12 2.12M18 12h3M16.24 7.76l2.12-2.12M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z"
  };

  path.setAttribute("d", paths[name]);
  svg.appendChild(path);
  return svg;
}

function createButton(id, label, iconName) {
  const button = document.createElement("button");
  button.id = id;
  button.type = "button";
  button.className = "navigator-icon-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.appendChild(createIcon(iconName));
  return button;
}

function renderNode(node, level = 0) {
  const container = document.createElement("div");
  container.className = `tree-node level-${level}`;
  container.dataset.search = `${node.role} ${node.text} ${node.fullText}`.toLowerCase();

  const content = document.createElement("button");
  content.type = "button";
  content.className = `node-content role-${node.role}`;
  content.title = node.fullText;

  const marker = document.createElement("span");
  marker.className = "node-marker";
  marker.appendChild(createIcon(node.role === "assistant" ? "assistant" : "user"));

  const copy = document.createElement("span");
  copy.className = "node-copy";

  const role = document.createElement("span");
  role.className = "node-role";
  role.textContent = node.role === "assistant" ? "Answer" : "Prompt";

  if (node.labelSource === "ai") {
    const aiBadge = document.createElement("span");
    aiBadge.className = "ai-badge";
    aiBadge.textContent = "AI";
    role.appendChild(aiBadge);
  }

  const text = document.createElement("span");
  text.className = "node-text";
  text.textContent = node.text;

  copy.append(role, text);
  content.append(marker, copy);

  content.addEventListener("click", () => {
    node.element.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  container.appendChild(content);

  if (node.children.length > 0) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "children";

    node.children.forEach((child) => {
      childrenContainer.appendChild(renderNode(child, level + 1));
    });

    container.appendChild(childrenContainer);
  }

  return container;
}

function applySearch(list, value) {
  const query = value.trim().toLowerCase();

  list.querySelectorAll(".tree-node").forEach((node) => {
    const childMatch = Array.from(node.querySelectorAll(".tree-node"))
      .some((child) => child.dataset.search.includes(query));
    const selfMatch = node.dataset.search.includes(query);
    node.classList.toggle("is-hidden", Boolean(query) && !selfMatch && !childMatch);
  });
}

function createSidebar(outline, messages) {
  document.getElementById(SIDEBAR_ID)?.remove();

  const sidebar = document.createElement("aside");
  sidebar.id = SIDEBAR_ID;
  sidebar.setAttribute("aria-label", "ChatGPT conversation navigator");
  sidebar.classList.toggle("is-collapsed", localStorage.getItem(COLLAPSED_KEY) === "true");

  const header = document.createElement("div");
  header.className = "sidebar-header";

  const headerTop = document.createElement("div");
  headerTop.className = "header-top";

  const brand = document.createElement("div");
  brand.className = "brand";

  const brandMark = document.createElement("span");
  brandMark.className = "brand-mark";
  brandMark.appendChild(createIcon("panel"));

  const brandCopy = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "Navigator";

  const subtitle = document.createElement("div");
  subtitle.className = "subtitle";
  subtitle.textContent = "Conversation map";

  brandCopy.append(title, subtitle);
  brand.append(brandMark, brandCopy);

  const actions = document.createElement("div");
  actions.className = "header-actions";

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(messages.length);
  count.title = `${messages.length} indexed messages`;

  const reload = createButton("reload-btn", "Refresh navigator", "refresh");
  reload.addEventListener("click", () => scheduleRender(0));

  actions.append(count, reload);
  headerTop.append(brand, actions);

  const searchWrap = document.createElement("label");
  searchWrap.className = "search-wrap";

  const searchIcon = document.createElement("span");
  searchIcon.className = "search-icon";
  searchIcon.appendChild(createIcon("search"));

  const searchInput = document.createElement("input");
  searchInput.id = "search-input";
  searchInput.type = "search";
  searchInput.placeholder = "Search prompts and answers";
  searchInput.setAttribute("aria-label", "Search conversation messages");

  searchWrap.append(searchIcon, searchInput);
  header.append(headerTop, searchWrap);

  const list = document.createElement("div");
  list.className = "block-list";

  if (outline.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No messages found in this open chat. Open a conversation, wait for it to load, then refresh.";
    list.appendChild(empty);
  } else {
    outline.forEach((node) => {
      list.appendChild(renderNode(node));
    });
  }

  searchInput.addEventListener("input", (event) => {
    applySearch(list, event.target.value);
  });

  sidebar.append(header, list);
  document.body.appendChild(sidebar);
}

function createToggle() {
  if (document.getElementById(TOGGLE_ID)) return;

  const button = createButton(TOGGLE_ID, "Toggle navigator", "panel");

  button.addEventListener("click", () => {
    const sidebar = document.getElementById(SIDEBAR_ID);
    if (!sidebar) return;

    const collapsed = !sidebar.classList.contains("is-collapsed");
    sidebar.classList.toggle("is-collapsed", collapsed);
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  });

  document.body.appendChild(button);
}

function render() {
  if (isRendering) return;

  isRendering = true;
  if (observer) observer.disconnect();

  const messages = getMessages();
  const outline = buildOutline(messages);

  createSidebar(outline, messages);
  createToggle();

  isRendering = false;
  startObserver();
}

function scheduleRender(delay = 250) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, delay);
}

function startObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver((mutations) => {
    const changedMessages = mutations.some((mutation) => {
      const target = mutation.target instanceof Element
        ? mutation.target
        : mutation.target.parentElement;

      return target && !target.closest(`#${SIDEBAR_ID}, #${TOGGLE_ID}`);
    });

    if (changedMessages) scheduleRender();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    scheduleRender(100);
  }
}, 1000);

scheduleRender(1000);
startObserver();
