const SIDEBAR_ID = "chatgpt-navigator-sidebar";
const TOGGLE_ID = "chatgpt-navigator-toggle";
const COLLAPSED_KEY = "chatgptNavigatorCollapsed";
const VIEW_MODE_KEY = "chatgptNavigatorViewMode";
const SIDEBAR_WIDTH_KEY = "chatgptNavigatorWidth";
const BRAIN_STORE_KEY = "chatgptNavigatorBrainStore";
const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
const TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"]',
  'article',
  'main [class*="group/conversation-turn"]'
].join(",");
const AI_LABEL_INPUT_LIMIT = 4000;
const VIEW_OUTLINE = "outline";
const VIEW_MINDMAP = "mindmap";
const VIEW_BRAIN = "brain";
const MINDMAP_MIN_SCALE = 0.05;
const MINDMAP_MAX_SCALE = 1.4;
const MINDMAP_ZOOM_STEP = 0.14;
const AI_RELATION_LABEL_LIMIT = 40;
const AI_RELATION_EXCERPT_LIMIT = 140;
const AI_RELATION_EXCERPT_MAX_PROMPTS = 40;
const BRAIN_MAX_CHATS = 24;
const BRAIN_MAX_PROMPTS_PER_CHAT = 80;
const BRAIN_MAX_SEMANTIC_EDGES = 180;

let isRendering = false;
let renderTimer = null;
let observer = null;
let lastUrl = location.href;
const aiLabelCache = new Map();
let summarizerPromise = null;
let languageModelSessionPromise = null;
let manualMindMapScale = null;
let manualBrainScale = null;
let relationAnalysisState = createEmptyRelationAnalysisState();
let suppressMindMapClickUntil = 0;

function logNavigatorError(scope, error) {
  console.error(`[ChatGPT Navigator] ${scope}`, error);
}

function createEmptyRelationAnalysisState(signature = "") {
  return {
    signature,
    status: "idle",
    topicsByPrompt: new Map(),
    relations: []
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

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

function cleanTopicLabel(label) {
  return cleanAiLabel(String(label || ""))
    .replace(/[.]+$/g, "")
    .slice(0, AI_RELATION_LABEL_LIMIT)
    .trim();
}

function shouldUseAiRelations(outline) {
  return outline.length > 1 && "LanguageModel" in globalThis;
}

async function getLanguageModelSession() {
  if (!("LanguageModel" in globalThis)) return null;
  if (languageModelSessionPromise) return languageModelSessionPromise;

  languageModelSessionPromise = (async () => {
    if (typeof globalThis.LanguageModel.availability !== "function") return null;

    const availability = await globalThis.LanguageModel.availability();
    if (availability === "unavailable") return null;

    if (typeof globalThis.LanguageModel.create !== "function") return null;

    return globalThis.LanguageModel.create({
      initialPrompts: [
        {
          role: "system",
          content: "You analyze user chat prompts. Return compact JSON only and prefer precise relationships over broad guesses."
        }
      ]
    });
  })().then((session) => {
    if (!session) languageModelSessionPromise = null;
    return session;
  }).catch((error) => {
    logNavigatorError("LanguageModel session failed", error);
    languageModelSessionPromise = null;
    return null;
  });

  return languageModelSessionPromise;
}

function getRelationAnalysisSignature(outline) {
  return outline
    .map((node) => `${node.promptIndex}:${node.fullText.slice(0, 220)}`)
    .join("\n");
}

function buildRelationAnalysisPayload(outline, labelsOnly = false) {
  const includeExcerpt = !labelsOnly && outline.length <= AI_RELATION_EXCERPT_MAX_PROMPTS;

  return outline.map((node) => ({
    index: node.promptIndex,
    label: node.text.slice(0, AI_RELATION_LABEL_LIMIT),
    excerpt: includeExcerpt
      ? node.fullText.replace(/\s+/g, " ").slice(0, AI_RELATION_EXCERPT_LIMIT)
      : ""
  }));
}

function normalizeRelationAnalysisResult(result, promptPayload) {
  const validPromptIds = new Set(promptPayload.map((prompt) => prompt.index));
  const topicsByPrompt = new Map();
  const relationKeys = new Set();
  const relations = [];
  const insights = Array.isArray(result?.promptInsights) ? result.promptInsights : [];

  insights.forEach((insight) => {
    const promptIndex = Number(insight?.index);
    if (!validPromptIds.has(promptIndex)) return;

    const topic = cleanTopicLabel(insight?.topic) || "Related thread";
    topicsByPrompt.set(promptIndex, topic);

    const related = Array.isArray(insight?.related)
      ? insight.related
      : [];

    related
      .map((value) => Number(value))
      .filter((relatedIndex) => validPromptIds.has(relatedIndex) && relatedIndex !== promptIndex)
      .slice(0, 3)
      .forEach((relatedIndex) => {
        const key = [promptIndex, relatedIndex].sort((a, b) => a - b).join(":");
        if (relationKeys.has(key)) return;
        relationKeys.add(key);
        relations.push({
          fromPromptIndex: promptIndex,
          toPromptIndex: relatedIndex
        });
      });
  });

  return {
    topicsByPrompt,
    relations
  };
}

async function analyzePromptRelations(outline, labelsOnly = false) {
  const session = await getLanguageModelSession();
  if (!session || typeof session.prompt !== "function") return null;

  const promptPayload = buildRelationAnalysisPayload(outline, labelsOnly);
  const schema = {
    type: "object",
    properties: {
      promptInsights: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            topic: { type: "string", maxLength: AI_RELATION_LABEL_LIMIT },
            related: {
              type: "array",
              maxItems: 3,
              items: { type: "integer" }
            }
          },
          required: ["index", "topic", "related"],
          additionalProperties: false
        }
      }
    },
    required: ["promptInsights"],
    additionalProperties: false
  };

  const promptText = [
    "Analyze these user prompts from one chat conversation.",
    "For each prompt index, assign a short topic label of 1 to 4 words.",
    "Also list up to 3 related prompt indices that clearly continue, depend on, or overlap with that prompt.",
    "Only use indices that appear in the input. Prefer an empty related list over a weak guess.",
    "",
    "Prompts JSON:",
    JSON.stringify(promptPayload)
  ].join("\n");

  const raw = await session.prompt(promptText, {
    responseConstraint: schema
  });

  return normalizeRelationAnalysisResult(JSON.parse(raw), promptPayload);
}

function getRelationAnalysisForOutline(outline) {
  const signature = getRelationAnalysisSignature(outline);
  return relationAnalysisState.signature === signature
    ? relationAnalysisState
    : createEmptyRelationAnalysisState(signature);
}

function ensureMindMapAnalysis(outline, force = false) {
  if (!shouldUseAiRelations(outline)) return;

  const signature = getRelationAnalysisSignature(outline);
  if (relationAnalysisState.signature === signature) {
    const settledStatuses = force
      ? ["pending", "ready"]
      : ["pending", "ready", "unavailable", "failed"];

    if (settledStatuses.includes(relationAnalysisState.status)) {
      return;
    }
  }

  if (
    relationAnalysisState.signature === signature &&
    relationAnalysisState.status === "pending"
  ) {
    return;
  }

  relationAnalysisState = createEmptyRelationAnalysisState(signature);
  relationAnalysisState.status = "pending";
  scheduleRender(0);

  const runAnalysis = async () => {
    try {
      return await analyzePromptRelations(outline, false);
    } catch (error) {
      if (error?.name === "QuotaExceededError") {
        return analyzePromptRelations(outline, true);
      }
      throw error;
    }
  };

  runAnalysis()
    .then((result) => {
      if (relationAnalysisState.signature !== signature) return;

      if (!result) {
        relationAnalysisState = {
          ...createEmptyRelationAnalysisState(signature),
          status: "unavailable"
        };
      } else {
        relationAnalysisState = {
          signature,
          status: "ready",
          topicsByPrompt: result.topicsByPrompt,
          relations: result.relations
        };
      }

      scheduleRender(0);
    })
    .catch((error) => {
      if (relationAnalysisState.signature !== signature) return;
      logNavigatorError("Prompt relation analysis failed", error);
      relationAnalysisState = {
        ...createEmptyRelationAnalysisState(signature),
        status: "failed"
      };
      scheduleRender(0);
    });
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
      node.promptIndex = outline.length;
      outline.push(node);
      currentUserNode = node;
      return;
    }

    currentUserNode.children.push(node);
  });

  return outline;
}

function getViewMode() {
  const viewMode = localStorage.getItem(VIEW_MODE_KEY);
  if ([VIEW_OUTLINE, VIEW_MINDMAP, VIEW_BRAIN].includes(viewMode)) return viewMode;
  return VIEW_OUTLINE;
}

function setViewMode(viewMode) {
  localStorage.setItem(VIEW_MODE_KEY, viewMode);
}

function getChatId() {
  const chatMatch = location.pathname.match(/\/c\/([^/?#]+)/);
  if (chatMatch) return chatMatch[1];

  return location.pathname || location.href;
}

function getConversationTitle(outline) {
  const firstPrompt = outline.find((node) => node.role === "user");
  return firstPrompt?.text || document.title.replace(/\s*\|\s*ChatGPT\s*$/i, "") || "Current chat";
}

function getTopicFromText(text) {
  return generateLabel(text)
    .split(/\s+/)
    .slice(0, 3)
    .join(" ") || "Untitled";
}

function getTopicKey(topic) {
  return String(topic || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getPromptTopic(node, relationAnalysis) {
  return relationAnalysis?.topicsByPrompt?.get(node.promptIndex) || getTopicFromText(node.fullText || node.text);
}

function readBrainStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BRAIN_STORE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (error) {
    logNavigatorError("reading brain store failed", error);
    return {};
  }
}

function writeBrainStore(store) {
  try {
    localStorage.setItem(BRAIN_STORE_KEY, JSON.stringify(store));
  } catch (error) {
    logNavigatorError("writing brain store failed", error);
  }
}

function persistConversationToBrain(outline) {
  if (outline.length === 0) return readBrainStore();

  const chatId = getChatId();
  const relationAnalysis = getRelationAnalysisForOutline(outline);
  const store = readBrainStore();
  const prompts = outline
    .slice(0, BRAIN_MAX_PROMPTS_PER_CHAT)
    .map((node) => {
      const topic = getPromptTopic(node, relationAnalysis);

      return {
        id: `${chatId}:${node.promptIndex}`,
        chatId,
        promptIndex: node.promptIndex,
        label: node.text,
        text: node.fullText,
        topic,
        topicKey: getTopicKey(topic),
        url: location.href
      };
    });

  store[chatId] = {
    id: chatId,
    title: getConversationTitle(outline),
    url: location.href,
    updatedAt: Date.now(),
    prompts
  };

  const orderedChatIds = Object.values(store)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((chat) => chat.id);

  orderedChatIds.slice(BRAIN_MAX_CHATS).forEach((oldChatId) => {
    delete store[oldChatId];
  });

  writeBrainStore(store);
  return store;
}

function buildBrainGraph(outline, rawQuery) {
  const currentStore = persistConversationToBrain(outline);
  const currentChatId = getChatId();
  const query = rawQuery.trim().toLowerCase();
  const chats = Object.values(currentStore)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const nodes = [];
  const edges = [];
  const nodesById = new Map();
  const topicBuckets = new Map();

  chats.forEach((chat) => {
    const chatNode = {
      id: `chat:${chat.id}`,
      type: "chat",
      label: chat.id === currentChatId ? "Current chat" : chat.title,
      title: chat.title,
      url: chat.url,
      current: chat.id === currentChatId,
      weight: Math.max(8, Math.min(28, (chat.prompts?.length || 0) * 1.8))
    };

    nodes.push(chatNode);
    nodesById.set(chatNode.id, chatNode);

    (chat.prompts || []).forEach((prompt) => {
      const haystack = `${prompt.label} ${prompt.text} ${prompt.topic} ${chat.title}`.toLowerCase();
      if (query && !haystack.includes(query)) return;

      const promptNode = {
        id: prompt.id,
        type: "prompt",
        label: prompt.label,
        title: prompt.text,
        topic: prompt.topic,
        topicKey: prompt.topicKey,
        chatId: chat.id,
        promptIndex: prompt.promptIndex,
        url: prompt.url,
        current: chat.id === currentChatId,
        weight: prompt.topicKey ? 8 : 6
      };

      nodes.push(promptNode);
      nodesById.set(promptNode.id, promptNode);

      edges.push({
        from: chatNode.id,
        to: promptNode.id,
        type: "chat",
        strength: 0.34
      });

      if (prompt.topicKey) {
        if (!topicBuckets.has(prompt.topicKey)) topicBuckets.set(prompt.topicKey, []);
        topicBuckets.get(prompt.topicKey).push(promptNode.id);
      }
    });
  });

  let semanticEdgeCount = 0;

  topicBuckets.forEach((promptIds, topicKey) => {
    if (promptIds.length < 2 || semanticEdgeCount >= BRAIN_MAX_SEMANTIC_EDGES) return;

    const topicNodeId = `topic:${topicKey}`;
    const topicNode = {
      id: topicNodeId,
      type: "topic",
      label: nodesById.get(promptIds[0])?.topic || "Related idea",
      title: `${promptIds.length} related prompts`,
      weight: Math.min(32, 10 + promptIds.length * 2.5)
    };

    nodes.push(topicNode);
    nodesById.set(topicNodeId, topicNode);

    promptIds.slice(0, 12).forEach((promptId) => {
      if (semanticEdgeCount >= BRAIN_MAX_SEMANTIC_EDGES) return;

      edges.push({
        from: topicNodeId,
        to: promptId,
        type: "semantic",
        strength: 0.7
      });
      semanticEdgeCount += 1;
    });
  });

  return {
    nodes,
    edges,
    chatCount: chats.length,
    currentChatId
  };
}

function getMinSidebarWidth() {
  return Math.min(360, Math.max(280, window.innerWidth - 24));
}

function getMaxSidebarWidth() {
  return Math.max(getMinSidebarWidth(), window.innerWidth - 24);
}

function getSidebarWidth() {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(stored)) return null;
  return clamp(stored, getMinSidebarWidth(), getMaxSidebarWidth());
}

function setSidebarWidth(width) {
  localStorage.setItem(
    SIDEBAR_WIDTH_KEY,
    String(clamp(width, getMinSidebarWidth(), getMaxSidebarWidth()))
  );
}

function matchesQuery(node, query) {
  const haystack = `${node.role} ${node.text} ${node.fullText}`.toLowerCase();
  return haystack.includes(query);
}

function filterOutline(outline, rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return outline;

  return outline.reduce((result, node) => {
    const selfMatch = matchesQuery(node, query);
    const children = selfMatch
      ? node.children
      : node.children.filter((child) => matchesQuery(child, query));

    if (selfMatch || children.length > 0) {
      result.push({
        ...node,
        children
      });
    }

    return result;
  }, []);
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

function createEmptyState(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function createViewTabs(selectedMode, onSelect) {
  const wrap = document.createElement("div");
  wrap.className = "view-switch";
  wrap.setAttribute("role", "tablist");
  wrap.setAttribute("aria-label", "Navigator view");

  [
    { value: VIEW_OUTLINE, label: "Outline" },
    { value: VIEW_MINDMAP, label: "Mind Map" },
    { value: VIEW_BRAIN, label: "Brain" }
  ].forEach((view) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "view-tab";
    button.textContent = view.label;
    button.dataset.view = view.value;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(selectedMode === view.value));
    button.classList.toggle("is-active", selectedMode === view.value);
    button.addEventListener("click", () => onSelect(view.value));
    wrap.appendChild(button);
  });

  return wrap;
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

function renderOutlineList(outline, rawQuery) {
  const filteredOutline = filterOutline(outline, rawQuery);
  const list = document.createElement("div");
  list.className = "block-list";

  if (filteredOutline.length === 0) {
    list.appendChild(createEmptyState("No matching prompts or answers in this chat yet."));
    return list;
  }

  filteredOutline.forEach((node) => {
    list.appendChild(renderNode(node));
  });

  return list;
}

function createMindMapCard(node, variant, x, y, width, metadata = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `map-card map-card-${variant} role-${node.role}`;
  button.style.left = `${x}px`;
  button.style.top = `${y}px`;
  button.style.width = `${width}px`;
  button.title = node.fullText;

  const role = document.createElement("span");
  role.className = "map-card-role";
  role.textContent = variant === "root"
    ? "Start"
    : node.role === "assistant"
      ? "Answer"
      : "Prompt";

  if (node.labelSource === "ai") {
    const aiBadge = document.createElement("span");
    aiBadge.className = "ai-badge";
    aiBadge.textContent = "AI";
    role.appendChild(aiBadge);
  }

  const text = document.createElement("span");
  text.className = "map-card-text";
  text.textContent = node.text;

  button.append(role, text);

  if (metadata.topic) {
    const topic = document.createElement("span");
    topic.className = "map-card-topic";
    topic.textContent = metadata.topic;
    button.appendChild(topic);
  }

  button.addEventListener("click", () => {
    if (Date.now() < suppressMindMapClickUntil) return;
    node.element.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return button;
}

function createSvgPath(d) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("opacity", "0.8");
  return path;
}

function getMindMapFitScale(viewport, width, height) {
  const availableWidth = Math.max(220, viewport.clientWidth - 24);
  const availableHeight = Math.max(220, viewport.clientHeight - 24);

  return clamp(
    Math.min(availableWidth / width, availableHeight / height, 0.72),
    MINDMAP_MIN_SCALE,
    MINDMAP_MAX_SCALE
  );
}

function createMapControlButton(label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mindmap-control-button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function createSidebarResizeHandle(sidebar) {
  const handle = document.createElement("div");
  handle.className = "sidebar-resize-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", "Resize navigator width");
  handle.setAttribute("aria-orientation", "vertical");

  let resizeState = null;

  handle.addEventListener("pointerdown", (event) => {
    resizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebar.getBoundingClientRect().width
    };

    handle.classList.add("is-active");
    document.body.classList.add("navigator-is-resizing");
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  const endResize = (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;

    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }

    handle.classList.remove("is-active");
    document.body.classList.remove("navigator-is-resizing");
    resizeState = null;
  };

  handle.addEventListener("pointermove", (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;

    const deltaX = resizeState.startX - event.clientX;
    const nextWidth = clamp(
      resizeState.startWidth + deltaX,
      getMinSidebarWidth(),
      getMaxSidebarWidth()
    );

    sidebar.style.width = `${nextWidth}px`;
    setSidebarWidth(nextWidth);
  });

  handle.addEventListener("pointerup", endResize);
  handle.addEventListener("pointercancel", endResize);

  return handle;
}

function createMindMap(outline, rawQuery) {
  const filteredOutline = filterOutline(outline, rawQuery);
  const list = document.createElement("div");
  list.className = "block-list block-list-map";

  if (filteredOutline.length === 0) {
    list.appendChild(createEmptyState("No matching branches to draw for this search."));
    return list;
  }

  const relationAnalysis = getRelationAnalysisForOutline(outline);
  const toolbar = document.createElement("div");
  toolbar.className = "mindmap-toolbar";

  const status = document.createElement("span");
  status.className = "mindmap-status";
  status.dataset.state = relationAnalysis.status;

  if (relationAnalysis.status === "pending") {
    status.textContent = "AI linking questions...";
  } else if (relationAnalysis.status === "ready") {
    status.textContent = "AI links ready";
  } else if (relationAnalysis.status === "unavailable") {
    status.textContent = "Mind map only";
  } else if (relationAnalysis.status === "failed") {
    status.textContent = "AI links skipped";
  } else {
    status.textContent = "Conversation flow";
  }

  const controls = document.createElement("div");
  controls.className = "mindmap-controls";

  const zoomOut = createMapControlButton("−", "Zoom out");
  const fit = createMapControlButton("Fit", "Fit the whole mind map");
  fit.classList.add("mindmap-fit-button");
  const zoomValue = document.createElement("span");
  zoomValue.className = "mindmap-zoom-value";
  const zoomIn = createMapControlButton("+", "Zoom in");

  controls.append(zoomOut, fit, zoomValue, zoomIn);
  toolbar.append(status, controls);

  const viewport = document.createElement("div");
  viewport.className = "mindmap-viewport";

  const canvas = document.createElement("div");
  canvas.className = "mindmap-canvas";

  const stage = document.createElement("div");
  stage.className = "mindmap-stage";

  const lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lines.classList.add("mindmap-lines");

  const relationLines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  relationLines.classList.add("mindmap-lines", "mindmap-lines-relations");

  const nodesLayer = document.createElement("div");
  nodesLayer.className = "mindmap-nodes";

  const rootNode = {
    role: outline[0]?.role || "user",
    text: outline[0]?.text || "This Chat",
    fullText: outline[0]?.fullText || "Conversation overview",
    labelSource: outline[0]?.labelSource || "rule",
    element: outline[0]?.element || document.body
  };

  const rootX = 30;
  const rootWidth = 120;
  const rootHeight = 72;
  const promptX = 190;
  const promptWidth = 188;
  const promptHeight = 88;
  const answerX = 428;
  const answerWidth = 186;
  const answerHeight = 80;
  const branchGap = 28;
  const answerGap = 16;
  const branchBaseHeight = 110;
  const answerBlockHeight = answerHeight + answerGap;
  const branches = [];
  const branchByPromptIndex = new Map();
  let cursorY = 28;

  filteredOutline.forEach((node) => {
    const branchHeight = Math.max(branchBaseHeight, Math.max(node.children.length, 1) * answerBlockHeight);
    const promptY = cursorY + (branchHeight - promptHeight) / 2;
    const promptCenterY = promptY + promptHeight / 2;
    const children = [];

    if (node.children.length > 0) {
      const childrenHeight = node.children.length * answerHeight + (node.children.length - 1) * answerGap;
      let childY = cursorY + (branchHeight - childrenHeight) / 2;

      node.children.forEach((child) => {
        children.push({
          node: child,
          x: answerX,
          y: childY,
          width: answerWidth,
          height: answerHeight
        });
        childY += answerBlockHeight;
      });
    }

    const branch = {
      node,
      x: promptX,
      y: promptY,
      width: promptWidth,
      height: promptHeight,
      centerY: promptCenterY,
      children
    };

    branches.push(branch);
    branchByPromptIndex.set(node.promptIndex, branch);

    cursorY += branchHeight + branchGap;
  });

  const totalHeight = Math.max(cursorY, 220);
  const totalWidth = answerX + answerWidth + 34;
  const rootY = (totalHeight - rootHeight) / 2;
  const rootCenterX = rootX + rootWidth;
  const rootCenterY = rootY + rootHeight / 2;

  stage.style.width = `${totalWidth}px`;
  stage.style.height = `${totalHeight}px`;
  lines.setAttribute("viewBox", `0 0 ${totalWidth} ${totalHeight}`);
  lines.setAttribute("width", String(totalWidth));
  lines.setAttribute("height", String(totalHeight));
  relationLines.setAttribute("viewBox", `0 0 ${totalWidth} ${totalHeight}`);
  relationLines.setAttribute("width", String(totalWidth));
  relationLines.setAttribute("height", String(totalHeight));

  nodesLayer.appendChild(createMindMapCard(rootNode, "root", rootX, rootY, rootWidth));

  branches.forEach((branch) => {
    const promptStartX = branch.x;
    const promptCenterY = branch.centerY;
    const promptCurveX = rootCenterX + 36;
    const promptCurveX2 = promptStartX - 36;
    const promptPath = `M ${rootCenterX} ${rootCenterY} C ${promptCurveX} ${rootCenterY}, ${promptCurveX2} ${promptCenterY}, ${promptStartX} ${promptCenterY}`;

    lines.appendChild(createSvgPath(promptPath));
    nodesLayer.appendChild(
      createMindMapCard(
        branch.node,
        "prompt",
        branch.x,
        branch.y,
        branch.width,
        {
          topic: relationAnalysis.topicsByPrompt.get(branch.node.promptIndex)
        }
      )
    );

    branch.children.forEach((child) => {
      const childStartX = child.x;
      const childCenterY = child.y + child.height / 2;
      const childFromX = branch.x + branch.width;
      const childCurveX = childFromX + 30;
      const childCurveX2 = childStartX - 24;
      const childPath = `M ${childFromX} ${promptCenterY} C ${childCurveX} ${promptCenterY}, ${childCurveX2} ${childCenterY}, ${childStartX} ${childCenterY}`;

      lines.appendChild(createSvgPath(childPath));
      nodesLayer.appendChild(createMindMapCard(child.node, "answer", child.x, child.y, child.width));
    });
  });

  relationAnalysis.relations.forEach((relation) => {
    const fromBranch = branchByPromptIndex.get(relation.fromPromptIndex);
    const toBranch = branchByPromptIndex.get(relation.toPromptIndex);
    if (!fromBranch || !toBranch) return;

    const startX = fromBranch.x;
    const startY = fromBranch.centerY;
    const endX = toBranch.x;
    const endY = toBranch.centerY;
    const controlX = promptX - 84;
    const relationPath = `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`;
    const path = createSvgPath(relationPath);
    path.classList.add("relation-line");
    path.setAttribute("stroke-dasharray", "7 8");
    relationLines.appendChild(path);
  });

  stage.append(lines, relationLines, nodesLayer);
  canvas.appendChild(stage);
  viewport.appendChild(canvas);
  list.append(toolbar, viewport);

  const applyScale = (nextScale, options = {}) => {
    const currentScale = Number(viewport.dataset.scale || 1);
    const clampedScale = clamp(nextScale, MINDMAP_MIN_SCALE, MINDMAP_MAX_SCALE);
    const rect = viewport.getBoundingClientRect();
    const anchorX = options.anchorClientX !== undefined
      ? clamp(options.anchorClientX - rect.left, 0, viewport.clientWidth)
      : viewport.clientWidth / 2;
    const anchorY = options.anchorClientY !== undefined
      ? clamp(options.anchorClientY - rect.top, 0, viewport.clientHeight)
      : viewport.clientHeight / 2;
    const worldX = (viewport.scrollLeft + anchorX) / currentScale;
    const worldY = (viewport.scrollTop + anchorY) / currentScale;

    viewport.dataset.scale = String(clampedScale);
    canvas.style.width = `${totalWidth * clampedScale}px`;
    canvas.style.height = `${totalHeight * clampedScale}px`;
    stage.style.transform = `scale(${clampedScale})`;
    zoomValue.textContent = `${Math.round(clampedScale * 100)}%`;

    if (options.persist !== false) {
      manualMindMapScale = clampedScale;
    }

    if (options.preserveCenter || options.anchorClientX !== undefined || options.anchorClientY !== undefined) {
      viewport.scrollLeft = Math.max(0, worldX * clampedScale - anchorX);
      viewport.scrollTop = Math.max(0, worldY * clampedScale - anchorY);
    } else {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  };

  zoomOut.addEventListener("click", () => {
    applyScale(Number(viewport.dataset.scale || 1) - MINDMAP_ZOOM_STEP, {
      preserveCenter: true
    });
  });

  fit.addEventListener("click", () => {
    manualMindMapScale = null;
    applyScale(getMindMapFitScale(viewport, totalWidth, totalHeight), {
      persist: false
    });
  });

  zoomIn.addEventListener("click", () => {
    applyScale(Number(viewport.dataset.scale || 1) + MINDMAP_ZOOM_STEP, {
      preserveCenter: true
    });
  });

  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();

    if (!event.ctrlKey) {
      viewport.scrollLeft += event.deltaX;
      viewport.scrollTop += event.deltaY;
      return;
    }

    const currentScale = Number(viewport.dataset.scale || 1);
    const delta = -event.deltaY * 0.0025;
    const nextScale = currentScale * (1 + delta);

    applyScale(nextScale, {
      preserveCenter: true,
      anchorClientX: event.clientX,
      anchorClientY: event.clientY
    });
  }, { passive: false });

  let dragState = null;

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest(".mindmap-control-button")) return;

    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      moved: false,
      captured: false
    };

    viewport.classList.add("is-dragging");
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;

    if (!dragState.moved && Math.hypot(deltaX, deltaY) > 8) {
      dragState.moved = true;
      suppressMindMapClickUntil = Date.now() + 250;

      if (!dragState.captured) {
        viewport.setPointerCapture(event.pointerId);
        dragState.captured = true;
      }
    }

    if (!dragState.moved) return;

    viewport.scrollLeft = dragState.scrollLeft - deltaX;
    viewport.scrollTop = dragState.scrollTop - deltaY;
  });

  const endDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    if (dragState.captured && viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }

    viewport.classList.remove("is-dragging");
    dragState = null;
  };

  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  requestAnimationFrame(() => {
    const initialScale = manualMindMapScale ?? getMindMapFitScale(viewport, totalWidth, totalHeight);
    applyScale(initialScale, {
      persist: manualMindMapScale !== null
    });
  });

  return list;
}

function getBrainNodeRadius(node) {
  if (node.type === "chat") return node.current ? 24 : 17;
  if (node.type === "topic") return node.weight || 16;
  return node.current ? 8 : 6;
}

function layoutBrainGraph(graph) {
  const width = 1180;
  const height = 880;
  const centerX = width / 2;
  const centerY = height / 2;
  const chats = graph.nodes.filter((node) => node.type === "chat");
  const topics = graph.nodes.filter((node) => node.type === "topic");
  const prompts = graph.nodes.filter((node) => node.type === "prompt");
  const positions = new Map();
  const currentChat = chats.find((chat) => chat.current);
  const otherChats = chats.filter((chat) => !chat.current);

  if (currentChat) {
    positions.set(currentChat.id, { x: centerX, y: centerY });
  }

  otherChats.forEach((chat, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(otherChats.length, 1) - Math.PI / 2;
    const radius = 300 + (index % 2) * 70;
    positions.set(chat.id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    });
  });

  const promptsByChat = prompts.reduce((result, prompt) => {
    if (!result.has(prompt.chatId)) result.set(prompt.chatId, []);
    result.get(prompt.chatId).push(prompt);
    return result;
  }, new Map());

  promptsByChat.forEach((chatPrompts, chatId) => {
    const chatPosition = positions.get(`chat:${chatId}`) || { x: centerX, y: centerY };
    const baseRadius = chatId === graph.currentChatId ? 190 : 105;

    chatPrompts.forEach((prompt, index) => {
      const angle = index * 2.399963 + (chatId === graph.currentChatId ? 0 : 0.7);
      const radius = baseRadius + (index % 4) * 28;
      positions.set(prompt.id, {
        x: clamp(chatPosition.x + Math.cos(angle) * radius, 46, width - 46),
        y: clamp(chatPosition.y + Math.sin(angle) * radius, 46, height - 46)
      });
    });
  });

  topics.forEach((topic) => {
    const connectedPositions = graph.edges
      .filter((edge) => edge.from === topic.id || edge.to === topic.id)
      .map((edge) => positions.get(edge.from === topic.id ? edge.to : edge.from))
      .filter(Boolean);

    if (connectedPositions.length > 0) {
      const average = connectedPositions.reduce((sum, position) => ({
        x: sum.x + position.x,
        y: sum.y + position.y
      }), { x: 0, y: 0 });

      positions.set(topic.id, {
        x: average.x / connectedPositions.length,
        y: average.y / connectedPositions.length
      });
      return;
    }

    positions.set(topic.id, {
      x: centerX,
      y: centerY
    });
  });

  return {
    width,
    height,
    positions
  };
}

function createBrainSvgLine(edge, positions) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return null;

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(from.x));
  line.setAttribute("y1", String(from.y));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y));
  line.setAttribute("class", `brain-edge brain-edge-${edge.type}`);
  line.setAttribute("stroke-width", edge.type === "semantic" ? "1.6" : "1");
  return line;
}

function createBrainSvgNode(node, position, outline) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", `brain-node brain-node-${node.type}${node.current ? " is-current" : ""}`);
  group.setAttribute("transform", `translate(${position.x} ${position.y})`);
  group.setAttribute("tabindex", "0");

  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = node.title || node.label;
  group.appendChild(title);

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("r", String(getBrainNodeRadius(node)));
  group.appendChild(circle);

  if (node.type !== "prompt" || node.current || node.weight > 12) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(getBrainNodeRadius(node) + 8));
    label.setAttribute("y", "4");
    label.textContent = node.type === "topic" ? node.label : node.label.slice(0, 32);
    group.appendChild(label);
  }

  const navigate = () => {
    if (Date.now() < suppressMindMapClickUntil) return;
    if (node.type === "topic") return;

    if (node.current && node.type === "prompt") {
      const promptNode = outline.find((item) => item.promptIndex === node.promptIndex);
      promptNode?.element?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    if (node.url && node.url !== location.href) {
      location.href = node.url;
    }
  };

  group.addEventListener("click", navigate);
  group.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    navigate();
  });

  return group;
}

function createBrainGraph(outline, rawQuery) {
  const graph = buildBrainGraph(outline, rawQuery);
  const list = document.createElement("div");
  list.className = "block-list block-list-map block-list-brain";

  if (graph.nodes.length === 0) {
    list.appendChild(createEmptyState("No saved prompt nodes yet. Open a chat with prompts, then refresh."));
    return list;
  }

  const toolbar = document.createElement("div");
  toolbar.className = "mindmap-toolbar";

  const status = document.createElement("span");
  status.className = "mindmap-status";
  status.dataset.state = "ready";
  status.textContent = `${graph.chatCount} chats · ${graph.nodes.length} nodes · ${graph.edges.length} links`;

  const controls = document.createElement("div");
  controls.className = "mindmap-controls";
  const zoomOut = createMapControlButton("−", "Zoom out");
  const fit = createMapControlButton("Fit", "Fit the whole graph");
  fit.classList.add("mindmap-fit-button");
  const zoomValue = document.createElement("span");
  zoomValue.className = "mindmap-zoom-value";
  const zoomIn = createMapControlButton("+", "Zoom in");
  controls.append(zoomOut, fit, zoomValue, zoomIn);
  toolbar.append(status, controls);

  const layout = layoutBrainGraph(graph);
  const viewport = document.createElement("div");
  viewport.className = "mindmap-viewport brain-viewport";

  const canvas = document.createElement("div");
  canvas.className = "mindmap-canvas brain-canvas";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("brain-stage");
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));

  const edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  edgeLayer.setAttribute("class", "brain-edges");
  graph.edges.forEach((edge) => {
    const line = createBrainSvgLine(edge, layout.positions);
    if (line) edgeLayer.appendChild(line);
  });

  const nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  nodeLayer.setAttribute("class", "brain-nodes");
  graph.nodes.forEach((node) => {
    const position = layout.positions.get(node.id);
    if (!position) return;
    nodeLayer.appendChild(createBrainSvgNode(node, position, outline));
  });

  svg.append(edgeLayer, nodeLayer);
  canvas.appendChild(svg);
  viewport.appendChild(canvas);
  list.append(toolbar, viewport);

  const applyScale = (nextScale, options = {}) => {
    const currentScale = Number(viewport.dataset.scale || 1);
    const clampedScale = clamp(nextScale, MINDMAP_MIN_SCALE, MINDMAP_MAX_SCALE);
    const rect = viewport.getBoundingClientRect();
    const anchorX = options.anchorClientX !== undefined
      ? clamp(options.anchorClientX - rect.left, 0, viewport.clientWidth)
      : viewport.clientWidth / 2;
    const anchorY = options.anchorClientY !== undefined
      ? clamp(options.anchorClientY - rect.top, 0, viewport.clientHeight)
      : viewport.clientHeight / 2;
    const worldX = (viewport.scrollLeft + anchorX) / currentScale;
    const worldY = (viewport.scrollTop + anchorY) / currentScale;

    viewport.dataset.scale = String(clampedScale);
    canvas.style.width = `${layout.width * clampedScale}px`;
    canvas.style.height = `${layout.height * clampedScale}px`;
    svg.style.transform = `scale(${clampedScale})`;
    zoomValue.textContent = `${Math.round(clampedScale * 100)}%`;

    if (options.persist !== false) manualBrainScale = clampedScale;

    if (options.preserveCenter || options.anchorClientX !== undefined || options.anchorClientY !== undefined) {
      viewport.scrollLeft = Math.max(0, worldX * clampedScale - anchorX);
      viewport.scrollTop = Math.max(0, worldY * clampedScale - anchorY);
    } else {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  };

  zoomOut.addEventListener("click", () => {
    applyScale(Number(viewport.dataset.scale || 1) - MINDMAP_ZOOM_STEP, { preserveCenter: true });
  });
  fit.addEventListener("click", () => {
    manualBrainScale = null;
    applyScale(getMindMapFitScale(viewport, layout.width, layout.height), { persist: false });
  });
  zoomIn.addEventListener("click", () => {
    applyScale(Number(viewport.dataset.scale || 1) + MINDMAP_ZOOM_STEP, { preserveCenter: true });
  });

  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();

    if (!event.ctrlKey) {
      viewport.scrollLeft += event.deltaX;
      viewport.scrollTop += event.deltaY;
      return;
    }

    const currentScale = Number(viewport.dataset.scale || 1);
    applyScale(currentScale * (1 - event.deltaY * 0.0025), {
      preserveCenter: true,
      anchorClientX: event.clientX,
      anchorClientY: event.clientY
    });
  }, { passive: false });

  let dragState = null;

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest(".mindmap-control-button")) return;

    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      moved: false,
      captured: false
    };

    viewport.classList.add("is-dragging");
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;

    if (!dragState.moved && Math.hypot(deltaX, deltaY) > 8) {
      dragState.moved = true;
      suppressMindMapClickUntil = Date.now() + 250;

      if (!dragState.captured) {
        viewport.setPointerCapture(event.pointerId);
        dragState.captured = true;
      }
    }

    if (!dragState.moved) return;

    viewport.scrollLeft = dragState.scrollLeft - deltaX;
    viewport.scrollTop = dragState.scrollTop - deltaY;
  });

  const endDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    if (dragState.captured && viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }

    viewport.classList.remove("is-dragging");
    dragState = null;
  };

  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  requestAnimationFrame(() => {
    const initialScale = manualBrainScale ?? getMindMapFitScale(viewport, layout.width, layout.height);
    applyScale(initialScale, { persist: manualBrainScale !== null });
  });

  return list;
}

function renderContent(outline, query, viewMode) {
  if (viewMode === VIEW_MINDMAP) return createMindMap(outline, query);
  if (viewMode === VIEW_BRAIN) return createBrainGraph(outline, query);
  return renderOutlineList(outline, query);
}

function createSidebar(outline, messages) {
  const previousSearch = document.getElementById("search-input")?.value || "";
  document.getElementById(SIDEBAR_ID)?.remove();

  const sidebar = document.createElement("aside");
  sidebar.id = SIDEBAR_ID;
  sidebar.setAttribute("aria-label", "ChatGPT conversation navigator");
  sidebar.classList.toggle("is-collapsed", localStorage.getItem(COLLAPSED_KEY) === "true");

  const sidebarWidth = getSidebarWidth();
  if (sidebarWidth) {
    sidebar.style.width = `${sidebarWidth}px`;
  }

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

  let currentViewMode = getViewMode();
  const viewTabs = createViewTabs(currentViewMode, (viewMode) => {
    currentViewMode = viewMode;
    setViewMode(viewMode);
    if (viewMode === VIEW_MINDMAP || viewMode === VIEW_BRAIN) {
      ensureMindMapAnalysis(outline, true);
    }
    rerenderContent();
  });

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
  searchInput.value = previousSearch;

  searchWrap.append(searchIcon, searchInput);
  header.append(headerTop, viewTabs, searchWrap);

  const content = document.createElement("div");
  content.className = "sidebar-body";

  function rerenderContent() {
    let nextView;

    try {
      nextView = outline.length === 0
        ? createEmptyState("No messages found in this open chat. Open a conversation, wait for it to load, then refresh.")
        : renderContent(outline, searchInput.value, currentViewMode);
    } catch (error) {
      logNavigatorError(`rendering ${currentViewMode} view failed, falling back to outline`, error);
      currentViewMode = VIEW_OUTLINE;
      setViewMode(VIEW_OUTLINE);
      nextView = outline.length === 0
        ? createEmptyState("No messages found in this open chat. Open a conversation, wait for it to load, then refresh.")
        : renderOutlineList(outline, searchInput.value);
    }

    content.replaceChildren(nextView);

    viewTabs.querySelectorAll(".view-tab").forEach((tab) => {
      const isActive = tab.dataset.view === currentViewMode;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
  }

  searchInput.addEventListener("input", rerenderContent);

  persistConversationToBrain(outline);

  if (currentViewMode === VIEW_MINDMAP || currentViewMode === VIEW_BRAIN) {
    ensureMindMapAnalysis(outline);
  }

  rerenderContent();

  sidebar.append(header, content);
  sidebar.appendChild(createSidebarResizeHandle(sidebar));
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

  try {
    createToggle();

    const messages = getMessages();
    const outline = buildOutline(messages);

    createSidebar(outline, messages);
  } catch (error) {
    logNavigatorError("render failed", error);
  } finally {
    isRendering = false;
    startObserver();
  }
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
