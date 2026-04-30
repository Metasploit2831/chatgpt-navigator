const SIDEBAR_ID = "chatgpt-navigator-sidebar";
const TOGGLE_ID = "chatgpt-navigator-toggle";
const COLLAPSED_KEY = "chatgptNavigatorCollapsed";
const VIEW_MODE_KEY = "chatgptNavigatorViewMode";
const SIDEBAR_WIDTH_KEY = "chatgptNavigatorWidth";
const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
const TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"]',
  'article',
  'main [class*="group/conversation-turn"]'
].join(",");
const AI_LABEL_INPUT_LIMIT = 4000;
const VIEW_OUTLINE = "outline";
const VIEW_MINDMAP = "mindmap";
const MINDMAP_MIN_SCALE = 0.05;
const MINDMAP_MAX_SCALE = 1.4;
const MINDMAP_ZOOM_STEP = 0.14;
const AI_RELATION_LABEL_LIMIT = 40;
const AI_RELATION_EXCERPT_LIMIT = 140;
const AI_RELATION_EXCERPT_MAX_PROMPTS = 40;

let isRendering = false;
let renderTimer = null;
let observer = null;
let lastUrl = location.href;
const aiLabelCache = new Map();
let summarizerPromise = null;
let languageModelSessionPromise = null;
let manualMindMapScale = null;
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
  return viewMode === VIEW_MINDMAP ? VIEW_MINDMAP : VIEW_OUTLINE;
}

function setViewMode(viewMode) {
  localStorage.setItem(VIEW_MODE_KEY, viewMode);
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
    { value: VIEW_MINDMAP, label: "Mind Map" }
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

function renderContent(outline, query, viewMode) {
  return viewMode === VIEW_MINDMAP
    ? createMindMap(outline, query)
    : renderOutlineList(outline, query);
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
    if (viewMode === VIEW_MINDMAP) {
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

  if (currentViewMode === VIEW_MINDMAP) {
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
