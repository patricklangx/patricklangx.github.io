(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const board = $('#board');
  const welcomePanel = $('#welcome-panel');
  const taskDialog = $('#task-dialog');
  const taskForm = $('#task-form');
  const infoDialog = $('#info-dialog');
  const toast = $('#toast');
  const themeToggle = $('#theme-toggle');
  const themeStorageKey = 'kanbanraum-theme';
  let languageCatalog = window.KANBAN_LANGUAGE;

  function t(key, values = {}) {
    const template = languageCatalog.messages[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? `{${name}}`));
  }

  function applyStaticTranslations() {
    document.documentElement.lang = languageCatalog.locale;
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      element.placeholder = t(element.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((element) => {
      element.title = t(element.dataset.i18nTitle);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
      element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
    });
    document.title = t('appTitle');
  }

  applyStaticTranslations();

  let projectHandle = null;
  let rootHandle = null;
  let savedRootHandle = null;
  let activeBoardFolder = null;
  let workspaceBoards = [];
  const expandedWorkspaceBoards = new Set();
  let phases = [];
  let phaseColors = new Map();
  let taskOrderByPhase = new Map();
  let tasks = [];
  let draggedTask = null;
  let currentView = 'board';
  let editingTask = null;
  let hideCompletedSubtasks = false;
  let draftSubtasks = [];
  let draftSubtasksSaving = false;
  let pendingFiles = new Map();
  let renderedImageUrls = [];
  let toastTimer = null;
  const dataDirectoryName = '__data';
  const trashDirectoryName = '__bin';
  const defaultPhaseNamesByLanguage = {
    de: ['Zu Erledigen', 'In Arbeit', 'Zurückgestellt', 'Fertig'],
    en: ['To Do', 'In Progress', 'In Review', 'Done'],
  };
  const renamedDefaultPhases = new Map([['Backlog', 'Zu Erledigen'], ['Erledigt', 'Fertig']]);
  const previousDefaultPhaseNames = ['Backlog', 'Offen', 'In Arbeit', 'Erledigt'];
  const phaseOrderFilename = '.phases.json';
  const boardIndexFilename = '.kanban-boards.json';
  const activeBoardStorageKey = 'kanbanraum-active-board';
  const commentsFilename = 'comments.md';
  const subtasksFilename = 'subtasks.md';
  const taskCreatedAtFilename = '.created-at';
  const taskPriorityFilename = '.priority';
  const taskTagsFilename = '.tags';
  const taskPriorities = new Set(['high', 'medium', 'low', 'none']);
  const handleDatabaseName = 'fokusboard-browser-settings';
  const handleStoreName = 'handles';
  const savedHandleKey = 'last-workspace';

  function defaultPhaseNames() {
    return defaultPhaseNamesByLanguage[languageCatalog.locale.startsWith('en') ? 'en' : 'de'];
  }

  function phaseDisplayName(name) {
    if (!languageCatalog.locale.startsWith('en')) return name;
    const englishNames = new Map([
      ['Zu Erledigen', 'To Do'], ['Backlog', 'To Do'],
      ['In Arbeit', 'In Progress'], ['In Prüfung', 'In Review'],
      ['Zurückgestellt', 'On Hold'],
      ['Fertig', 'Done'], ['Erledigt', 'Done'],
    ]);
    if (languageCatalog.locale.startsWith('en')) return englishNames.get(name) ?? name;
    const germanNames = new Map([
      ['To Do', 'Zu Erledigen'], ['In Progress', 'In Arbeit'],
      ['In Review', 'In Prüfung'], ['Done', 'Fertig'],
    ]);
    return germanNames.get(name) ?? name;
  }

  function isCompletedPhase(name) {
    return ['fertig', 'fertiggestellt', 'erledigt', 'done', 'completed']
      .includes(name.trim().toLocaleLowerCase());
  }

  function preferredTheme() {
    try {
      const savedTheme = localStorage.getItem(themeStorageKey);
      if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
    } catch (error) {
      console.warn('Die gespeicherte Darstellung konnte nicht gelesen werden.', error);
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function setTheme(theme, persist = true) {
    const isDark = theme === 'dark';
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    $('#theme-toggle-icon').textContent = isDark ? '☀' : '☾';
    const label = t(isDark ? 'themeLight' : 'themeDark');
    themeToggle.setAttribute('aria-label', label);
    themeToggle.title = label;
    $('meta[name="theme-color"]').content = isDark ? '#171922' : '#f6f7fb';
    if (persist) {
      try { localStorage.setItem(themeStorageKey, isDark ? 'dark' : 'light'); }
      catch (error) { console.warn('Die Darstellung konnte nicht gespeichert werden.', error); }
    }
  }

  setTheme(preferredTheme(), false);

  const supportsDirectoryAccess = 'showDirectoryPicker' in window;
  if (!supportsDirectoryAccess) {
    $('#browser-hint').textContent = t('browserUnsupported');
    $('#open-folder').title = t('browserOpenHint');
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function safeName(value) {
    return value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').slice(0, 90) || t('newTaskTitle');
  }

  function uniqueFolderName(name, existingNames) {
    const base = safeName(name);
    let candidate = base;
    let suffix = 2;
    while (existingNames.has(candidate.toLocaleLowerCase())) {
      candidate = `${base} (${suffix++})`;
    }
    return candidate;
  }

  async function ensurePermission(handle, write = false) {
    const options = write ? { mode: 'readwrite' } : {};
    if (await handle.queryPermission(options) === 'granted') return true;
    return (await handle.requestPermission(options)) === 'granted';
  }

  function openHandleDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(handleDatabaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(handleStoreName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveWorkspaceHandle(handle) {
    const database = await openHandleDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(handleStoreName, 'readwrite');
        transaction.objectStore(handleStoreName).put(handle, savedHandleKey);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  async function getSavedWorkspaceHandle() {
    const database = await openHandleDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(handleStoreName, 'readonly');
        const request = transaction.objectStore(handleStoreName).get(savedHandleKey);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }

  function activeBoardName() {
    return activeBoardFolder ?? t('boardTitle');
  }

  async function readWorkspaceBoards() {
    try {
      const fileHandle = await projectHandle.getFileHandle(boardIndexFilename);
      const data = JSON.parse(await (await fileHandle.getFile()).text());
      if (!Array.isArray(data.boards)) throw new Error('Boardliste ist ungültig.');
      const listedBoards = [...new Set(data.boards.filter((name) =>
        typeof name === 'string'
        && name.trim()
        && name === safeName(name)
        && !name.startsWith('.')
        && name.toLocaleLowerCase() !== trashDirectoryName))];
      workspaceBoards = [];
      for (const name of listedBoards) {
        try {
          await projectHandle.getDirectoryHandle(name);
          workspaceBoards.push(name);
        } catch (error) {
          if (error.name !== 'NotFoundError') throw error;
          console.warn(`Registriertes Board „${name}“ wurde im Projektordner nicht gefunden.`);
        }
      }
    } catch (error) {
      if (error.name === 'NotFoundError') {
        workspaceBoards = [];
        return;
      }
      throw error;
    }
  }

  async function saveWorkspaceBoards() {
    const fileHandle = await projectHandle.getFileHandle(boardIndexFilename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(`${JSON.stringify({ version: 1, boards: workspaceBoards }, null, 2)}\n`);
    await writable.close();
  }

  async function writeTaskPriority(taskHandle, priority) {
    if (!taskPriorities.has(priority)) throw new Error(`Ungültige Arbeitspaketpriorität: ${priority}`);
    const fileHandle = await taskHandle.getFileHandle(taskPriorityFilename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(priority);
    await writable.close();
  }

  function normalizeTaskTags(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(/[,\r\n]/);
    const tags = [];
    const seen = new Set();
    for (const candidate of values) {
      if (typeof candidate !== 'string') continue;
      const tag = candidate.trim();
      const key = tag.toLocaleLowerCase();
      if (tag && !seen.has(key)) {
        seen.add(key);
        tags.push(tag);
      }
    }
    return tags;
  }

  async function writeTaskTags(taskHandle, tags) {
    const fileHandle = await taskHandle.getFileHandle(taskTagsFilename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(normalizeTaskTags(tags).join('\n'));
    await writable.close();
  }

  function readActiveBoardSelection() {
    try { return localStorage.getItem(activeBoardStorageKey); }
    catch (error) {
      console.warn('Die gespeicherte Boardauswahl konnte nicht gelesen werden.', error);
      return null;
    }
  }

  function renderWorkspaceBoards() {
    const list = $('#workspace-board-list');
    list.replaceChildren();
    if (!projectHandle) return;
    for (const boardName of workspaceBoards) {
      const boardSelected = boardName === activeBoardFolder;
      const group = makeElement('div', `workspace-board-group${boardSelected ? ' workspace-board-selected' : ''}`);
      const boardRow = makeElement('div', 'workspace-board-row');
      const overviewExpanded = expandedWorkspaceBoards.has(boardName);
      const overviewToggle = makeElement('button', 'workspace-board-toggle');
      overviewToggle.type = 'button';
      overviewToggle.setAttribute('aria-label', t('toggleOverview', { board: boardName }));
      overviewToggle.setAttribute('aria-expanded', String(overviewExpanded));
      overviewToggle.title = t('toggleOverview', { board: boardName });
      overviewToggle.append(makeElement('span', '', overviewExpanded ? '▾' : '▸'));
      overviewToggle.addEventListener('click', () => {
        if (overviewExpanded) expandedWorkspaceBoards.delete(boardName);
        else expandedWorkspaceBoards.add(boardName);
        renderWorkspaceBoards();
      });
      const button = makeElement('button', `nav-item workspace-board${boardSelected && currentView === 'board' ? ' nav-active' : ' nav-muted'}`);
      button.type = 'button';
      if (boardSelected && currentView === 'board') button.setAttribute('aria-current', 'page');
      const boardIcon = makeElement('span', '', '▦');
      boardIcon.setAttribute('aria-hidden', 'true');
      button.append(boardIcon, makeElement('span', 'workspace-board-name', boardName));
      button.addEventListener('click', () => void selectWorkspaceBoard(boardName));
      boardRow.append(button, overviewToggle);
      const overviewButton = makeElement('button', `nav-item workspace-board-overview${boardSelected && currentView === 'overview' ? ' nav-active' : ' nav-muted'}`);
      overviewButton.type = 'button';
      overviewButton.hidden = !overviewExpanded;
      if (boardSelected && currentView === 'overview') overviewButton.setAttribute('aria-current', 'page');
      const overviewIcon = makeElement('span', '', '⌁');
      overviewIcon.setAttribute('aria-hidden', 'true');
      overviewButton.append(overviewIcon, makeElement('span', 'workspace-board-name', t('navOverview')));
      overviewButton.addEventListener('click', () => {
        expandedWorkspaceBoards.add(boardName);
        void selectWorkspaceBoard(boardName, 'overview');
      });
      group.append(boardRow, overviewButton);
      list.append(group);
    }
  }

  async function selectWorkspaceBoard(folderName, view = 'board') {
    if (!projectHandle || !workspaceBoards.includes(folderName)) return;
    const previousRoot = rootHandle;
    const previousBoardFolder = activeBoardFolder;
    try {
      const selectedHandle = await projectHandle.getDirectoryHandle(folderName);
      if (!await ensurePermission(selectedHandle, true)) {
        showToast(t('permissionDenied'));
        return;
      }
      rootHandle = selectedHandle;
      activeBoardFolder = folderName;
      currentView = view;
      try { localStorage.setItem(activeBoardStorageKey, folderName ?? ''); }
      catch (error) { console.warn('Das ausgewählte Board konnte nicht lokal gespeichert werden.', error); }
      await loadWorkspace();
      updateWorkspaceLabel();
      renderBoard();
      return true;
    } catch (error) {
      rootHandle = previousRoot;
      activeBoardFolder = previousBoardFolder;
      try { localStorage.setItem(activeBoardStorageKey, previousBoardFolder ?? ''); }
      catch (storageError) { console.warn('Die zuvor ausgewählte Boardauswahl konnte nicht wiederhergestellt werden.', storageError); }
      renderWorkspaceBoards();
      if (previousRoot) {
        try { await loadWorkspace(); }
        catch (restoreError) { console.warn('Das zuvor ausgewählte Board konnte nach einem fehlgeschlagenen Wechsel nicht wiederhergestellt werden.', restoreError); }
      } else {
        phases = [];
        tasks = [];
        renderBoard();
      }
      showToast(t('boardOpenError', { error: error.message }));
      return false;
    }
  }

  function updateWorkspaceLabel() {
    $('#workspace-name').textContent = projectHandle?.name ?? t('workspaceName');
    $('#workspace-path').textContent = projectHandle
      ? (rootHandle ? t('activeBoardLabel', { board: activeBoardName() }) : t('noBoardActive'))
      : t('workspacePath');
    $('#restore-folder').hidden = true;
    $('#add-board-button').disabled = !projectHandle;
    renderWorkspaceBoards();
  }

  async function restoreLastWorkspace() {
    if (!supportsDirectoryAccess || !('indexedDB' in window)) return;
    try {
      savedRootHandle = await getSavedWorkspaceHandle();
      if (!savedRootHandle) return;
      if (await savedRootHandle.queryPermission({ mode: 'readwrite' }) === 'granted') {
        projectHandle = savedRootHandle;
        await readWorkspaceBoards();
        const savedBoard = readActiveBoardSelection();
        activeBoardFolder = workspaceBoards.includes(savedBoard) ? savedBoard : null;
        rootHandle = activeBoardFolder
          ? await projectHandle.getDirectoryHandle(activeBoardFolder)
          : null;
        if (rootHandle) await loadWorkspace();
        else {
          phases = [];
          tasks = [];
          renderBoard();
          await updateTrashButton();
        }
        updateWorkspaceLabel();
        showToast(t('savedFolderReopened', { name: savedRootHandle.name }));
      } else {
        $('#restore-folder').hidden = false;
        $('#restore-hint').textContent = t('lastWorkspaceHint', { name: savedRootHandle.name });
        $('#restore-hint').hidden = false;
      }
    } catch (error) {
      console.warn(t('browserRestoreWarning'), error);
      if (savedRootHandle) {
        $('#restore-folder').hidden = false;
        $('#restore-hint').textContent = t('lastWorkspacePermission', { name: savedRootHandle.name });
        $('#restore-hint').hidden = false;
      }
    }
  }

  async function reconnectLastWorkspace() {
    if (!savedRootHandle) return;
    try {
      if (!await ensurePermission(savedRootHandle, true)) {
        showToast(t('savedFolderDenied'));
        return;
      }
      projectHandle = savedRootHandle;
      await readWorkspaceBoards();
      const savedBoard = readActiveBoardSelection();
      activeBoardFolder = workspaceBoards.includes(savedBoard) ? savedBoard : null;
      rootHandle = activeBoardFolder
        ? await projectHandle.getDirectoryHandle(activeBoardFolder)
        : null;
      if (rootHandle) await loadWorkspace();
      else {
        phases = [];
        tasks = [];
        renderBoard();
        await updateTrashButton();
      }
      updateWorkspaceLabel();
      showToast(t('savedFolderReopened', { name: savedRootHandle.name }));
    } catch (error) {
      showToast(t('savedFolderError', { error: error.message }));
    }
  }

  async function openWorkspace() {
    if (!supportsDirectoryAccess) {
      showToast(t('unsupportedBrowser'));
      return;
    }
    try {
      const selected = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (!(await ensurePermission(selected, true))) {
        showToast(t('permissionDenied'));
        return;
      }
      projectHandle = selected;
      rootHandle = null;
      activeBoardFolder = null;
      currentView = 'board';
      try { localStorage.removeItem(activeBoardStorageKey); }
      catch (error) { console.warn('Die gespeicherte Boardauswahl konnte nicht zurückgesetzt werden.', error); }
      savedRootHandle = selected;
      let handleWasSaved = true;
      try { await saveWorkspaceHandle(selected); }
      catch (error) {
        handleWasSaved = false;
        console.warn('Der Projektordner konnte nicht für den nächsten Start gespeichert werden.', error);
      }
      await readWorkspaceBoards();
      updateWorkspaceLabel();
      renderBoard();
      await updateTrashButton();
      showToast(handleWasSaved ? t('openedAndRestored', { name: projectHandle.name }) : t('openedRestoreFailed', { name: projectHandle.name }));
    } catch (error) {
      if (error.name !== 'AbortError') showToast(t('folderOpenError', { error: error.message }));
    }
  }

  function openWorkspaceBoardDialog() {
    if (!projectHandle) return;
    $('#board-name').value = '';
    $('#board-dialog').showModal();
    $('#board-name').focus();
  }

  async function createWorkspaceBoard(event) {
    event.preventDefault();
    if (!projectHandle) return;
    const nameInput = $('#board-name');
    const input = nameInput.value.trim();
    if (!input) {
      nameInput.value = '';
      nameInput.reportValidity();
      return;
    }
    const folderName = safeName(input);
    if (folderName.startsWith('.')) {
      showToast(t('invalidBoardName'));
      return;
    }
    if (folderName.toLocaleLowerCase() === trashDirectoryName) {
      showToast(t('boardNameExists', { name: folderName }));
      return;
    }
    const submitButton = $('#create-board-submit');
    submitButton.disabled = true;
    try {
      if (!await ensurePermission(projectHandle, true)) {
        showToast(t('permissionDenied'));
        return;
      }
      const existingNames = new Set();
      for await (const [name] of projectHandle.entries()) existingNames.add(name.toLocaleLowerCase());
      if (existingNames.has(folderName.toLocaleLowerCase())) {
        showToast(t('boardNameExists', { name: folderName }));
        return;
      }
      await projectHandle.getDirectoryHandle(folderName, { create: true });
      workspaceBoards.push(folderName);
      try {
        await saveWorkspaceBoards();
      } catch (error) {
        workspaceBoards = workspaceBoards.filter((name) => name !== folderName);
        try { await projectHandle.removeEntry(folderName, { recursive: true }); }
        catch (cleanupError) { console.warn('Nicht registrierter Boardordner konnte nicht bereinigt werden.', cleanupError); }
        throw error;
      }
      renderWorkspaceBoards();
      $('#board-dialog').close();
      if (await selectWorkspaceBoard(folderName)) showToast(t('boardCreated', { name: folderName }));
    } catch (error) {
      showToast(t('boardCreateError', { error: error.message }));
    } finally {
      submitButton.disabled = false;
    }
  }

  async function moveWorkspaceBoardToTrash(boardName) {
    if (!projectHandle || !workspaceBoards.includes(boardName)) return;
    if (!window.confirm(t('boardDeleteConfirm', { name: boardName }))) return;

    try {
      if (!await ensurePermission(projectHandle, true)) throw new Error(t('writePermissionDenied'));
      const boardHandle = await projectHandle.getDirectoryHandle(boardName);
      const trash = await projectHandle.getDirectoryHandle(trashDirectoryName, { create: true });
      const existingTrashNames = new Set();
      for await (const [name] of trash.entries()) existingTrashNames.add(name.toLocaleLowerCase());
      let trashName = boardName;
      let suffix = 2;
      while (existingTrashNames.has(trashName.toLocaleLowerCase())) trashName = `${boardName} (${suffix++})`;
      const destination = await trash.getDirectoryHandle(trashName, { create: true });
      const previousBoards = workspaceBoards;
      let boardListUpdateAttempted = false;
      try {
        await copyDirectory(boardHandle, destination);
        workspaceBoards = workspaceBoards.filter((name) => name !== boardName);
        boardListUpdateAttempted = true;
        await saveWorkspaceBoards();
        await projectHandle.removeEntry(boardName, { recursive: true });
      } catch (error) {
        workspaceBoards = previousBoards;
        if (boardListUpdateAttempted) {
          try { await saveWorkspaceBoards(); }
          catch (rollbackError) { console.warn('Die Boardliste konnte nach einem fehlgeschlagenen Verschieben nicht wiederhergestellt werden.', rollbackError); }
        }
        try { await trash.removeEntry(trashName, { recursive: true }); }
        catch (cleanupError) { console.warn('Unvollständige Boardkopie konnte nicht bereinigt werden.', cleanupError); }
        throw error;
      }

      expandedWorkspaceBoards.delete(boardName);
      const wasActive = activeBoardFolder === boardName;
      if (wasActive) {
        rootHandle = null;
        activeBoardFolder = null;
        currentView = 'board';
        phases = [];
        tasks = [];
        phaseColors = new Map();
        taskOrderByPhase = new Map();
        try { localStorage.removeItem(activeBoardStorageKey); }
        catch (error) { console.warn('Die gespeicherte Boardauswahl konnte nicht zurückgesetzt werden.', error); }
      }
      updateWorkspaceLabel();
      renderBoard();
      showToast(t('boardDeleted', { name: boardName }));

      if (wasActive && workspaceBoards.length) await selectWorkspaceBoard(workspaceBoards[0]);
      else await updateTrashButton();
    } catch (error) {
      showToast(t('boardDeleteError', { error: error.message }));
    }
  }

  async function readTask(taskHandle, phaseName) {
    const markdownFiles = [];
    for await (const [name, handle] of taskHandle.entries()) {
      if (handle.kind === 'file' && name.toLowerCase().endsWith('.md') && ![commentsFilename, subtasksFilename].includes(name.toLowerCase())) markdownFiles.push({ name, handle });
    }
    markdownFiles.sort((a, b) => {
      const rank = (name) => name.toLowerCase() === 'task.md' ? 0 : name.toLowerCase() === 'readme.md' ? 1 : 2;
      return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'de');
    });

    let markdown = '';
    let markdownName = 'task.md';
    let createdAt = null;
    if (markdownFiles.length) {
      markdownName = markdownFiles[0].name;
      const markdownFile = await markdownFiles[0].handle.getFile();
      markdown = await markdownFile.text();
      if (Number.isFinite(markdownFile.lastModified)) createdAt = markdownFile.lastModified;
    }
    try {
      const createdAtHandle = await taskHandle.getFileHandle(taskCreatedAtFilename);
      const storedDate = Date.parse(await (await createdAtHandle.getFile()).text());
      if (Number.isFinite(storedDate)) createdAt = storedDate;
    } catch (error) {
      if (error.name !== 'NotFoundError') console.warn(`Erstellungsdatum für „${taskHandle.name}“ konnte nicht gelesen werden.`, error);
    }
    let comments = [];
    try {
      const commentsHandle = await taskHandle.getFileHandle(commentsFilename);
      comments = parseComments(await (await commentsHandle.getFile()).text());
    } catch (error) {
      if (error.name !== 'NotFoundError') console.warn(`Kommentare für „${taskHandle.name}“ konnten nicht gelesen werden.`, error);
    }
    let subtasks = [];
    try {
      const subtasksHandle = await taskHandle.getFileHandle(subtasksFilename);
      subtasks = parseSubtasks(await (await subtasksHandle.getFile()).text());
    } catch (error) {
      if (error.name !== 'NotFoundError') console.warn(`Unteraufgaben für „${taskHandle.name}“ konnten nicht gelesen werden.`, error);
    }
    let priority = 'none';
    try {
      const priorityHandle = await taskHandle.getFileHandle(taskPriorityFilename);
      const storedPriority = (await (await priorityHandle.getFile()).text()).trim();
      if (taskPriorities.has(storedPriority)) priority = storedPriority;
      else console.warn(`Ungültige Priorität für „${taskHandle.name}“; „keine“ wird verwendet.`);
    } catch (error) {
      if (error.name !== 'NotFoundError') console.warn(`Priorität für „${taskHandle.name}“ konnte nicht gelesen werden.`, error);
    }
    let tags = [];
    try {
      const tagsHandle = await taskHandle.getFileHandle(taskTagsFilename);
      tags = normalizeTaskTags((await (await tagsHandle.getFile()).text()).split(/\r?\n/));
    } catch (error) {
      if (error.name !== 'NotFoundError') console.warn(`Tags für „${taskHandle.name}“ konnten nicht gelesen werden.`, error);
    }
    const heading = markdown.match(/^#\s+(.+)\s*$/m);
    const details = heading ? markdown.replace(heading[0], '').trim() : markdown.trim();
    return {
      id: `${phaseName}/${taskHandle.name}`,
      phase: phaseName,
      folderName: taskHandle.name,
      title: heading ? heading[1].trim() : taskHandle.name,
      details,
      markdownName,
      handle: taskHandle,
      hasMarkdown: markdownFiles.length > 0,
      createdAt,
      priority,
      tags,
      comments,
      subtasks,
    };
  }

  function parseSubtasks(markdown) {
    return markdown.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
      return match ? [{ text: match[2], completed: match[1].toLowerCase() === 'x' }] : [];
    });
  }

  async function writeSubtasks(taskHandle, subtasks) {
    const fileHandle = await taskHandle.getFileHandle(subtasksFilename, { create: true });
    const writable = await fileHandle.createWritable();
    const lines = subtasks.map(({ text, completed }) => `- [${completed ? 'x' : ' '}] ${text.trim()}`);
    await writable.write(`# Unteraufgaben\n\n${lines.join('\n')}\n`);
    await writable.close();
  }

  async function writeTaskCreatedAt(taskHandle, timestamp = Date.now()) {
    const fileHandle = await taskHandle.getFileHandle(taskCreatedAtFilename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(new Date(timestamp).toISOString());
    await writable.close();
  }

  function parseComments(markdown) {
    const match = markdown.match(/^```json\s*\n([\s\S]*?)\n```\s*$/m);
    if (!match) return [];
    try {
      const comments = JSON.parse(match[1]);
      if (!Array.isArray(comments)) return [];
      return comments.filter((comment) => comment && typeof comment.id === 'string' && typeof comment.text === 'string');
    } catch (error) {
      console.warn('comments.md enthält kein gültiges Kommentarformat.', error);
      return [];
    }
  }

  async function writeComments(taskHandle, comments) {
    const fileHandle = await taskHandle.getFileHandle(commentsFilename, { create: true });
    const writable = await fileHandle.createWritable();
    const body = `# Kommentare\n\n\`\`\`json\n${JSON.stringify(comments, null, 2)}\n\`\`\`\n`;
    await writable.write(body);
    await writable.close();
  }

  async function readPhaseOrder() {
    phaseColors = new Map();
    taskOrderByPhase = new Map();
    try {
      const handle = await rootHandle.getFileHandle(phaseOrderFilename);
      const data = JSON.parse(await (await handle.getFile()).text());
      const colors = data.colors && typeof data.colors === 'object' ? Object.entries(data.colors) : [];
      phaseColors = new Map(colors.filter(([, color]) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)));
      if (data.taskOrder && typeof data.taskOrder === 'object' && !Array.isArray(data.taskOrder)) {
        taskOrderByPhase = new Map(Object.entries(data.taskOrder)
          .filter(([, order]) => Array.isArray(order))
          .map(([phase, order]) => [phase, order.filter((name) => typeof name === 'string')]));
      }
      return Array.isArray(data.order) ? data.order.filter((name) => typeof name === 'string') : [];
    } catch (error) {
      if (error.name !== 'NotFoundError') console.warn('Phasenreihenfolge konnte nicht gelesen werden.', error);
      return [];
    }
  }

  async function savePhaseOrder(order) {
    const handle = await rootHandle.getFileHandle(phaseOrderFilename, { create: true });
    const writable = await handle.createWritable();
    const colors = Object.fromEntries(order.filter((name) => phaseColors.has(name)).map((name) => [name, phaseColors.get(name)]));
    const taskOrder = Object.fromEntries(order
      .filter((name) => taskOrderByPhase.has(name))
      .map((name) => [name, taskOrderByPhase.get(name)]));
    await writable.write(`${JSON.stringify({ version: 1, order, colors, taskOrder }, null, 2)}\n`);
    await writable.close();
  }

  async function loadWorkspace() {
    phases = [];
    tasks = [];
    if (!rootHandle) {
      renderBoard();
      return;
    }
    const phaseEntries = [];
    for await (const [name, handle] of rootHandle.entries()) {
      if (handle.kind !== 'directory' || name.startsWith('.')) continue;
      if (name.toLocaleLowerCase() === trashDirectoryName) continue;
      phaseEntries.push([name, handle]);
    }
    const existingPhaseNames = new Set(phaseEntries.map(([name]) => name));
    if (previousDefaultPhaseNames.every((name) => existingPhaseNames.has(name)) && !existingPhaseNames.has('In Prüfung')) {
      const legacyIndex = phaseEntries.findIndex(([name]) => name === 'Offen');
      let destinationCreated = false;
      let sourceRemoved = false;
      try {
        const destination = await rootHandle.getDirectoryHandle('In Prüfung', { create: true });
        destinationCreated = true;
        await copyDirectory(phaseEntries[legacyIndex][1], destination);
        await rootHandle.removeEntry('Offen', { recursive: true });
        sourceRemoved = true;
        phaseEntries[legacyIndex] = ['In Prüfung', destination];
      } catch (error) {
        if (destinationCreated && !sourceRemoved) {
          try { await rootHandle.removeEntry('In Prüfung', { recursive: true }); }
          catch (cleanupError) { console.warn('Unvollständige Migration der Phase konnte nicht bereinigt werden.', cleanupError); }
        }
        console.warn('Die bisherige Standardphase „Offen“ konnte nicht automatisch umbenannt werden.', error);
      }
    }
    const migratedPhaseNames = new Map();
    for (const [oldName, newName] of renamedDefaultPhases) {
      const sourceIndex = phaseEntries.findIndex(([name]) => name === oldName);
      if (sourceIndex < 0 || phaseEntries.some(([name]) => name === newName)) continue;
      let destinationCreated = false;
      let sourceRemoved = false;
      try {
        const destination = await rootHandle.getDirectoryHandle(newName, { create: true });
        destinationCreated = true;
        await copyDirectory(phaseEntries[sourceIndex][1], destination);
        await rootHandle.removeEntry(oldName, { recursive: true });
        sourceRemoved = true;
        phaseEntries[sourceIndex] = [newName, destination];
        migratedPhaseNames.set(oldName, newName);
      } catch (error) {
        if (destinationCreated && !sourceRemoved) {
          try { await rootHandle.removeEntry(newName, { recursive: true }); }
          catch (cleanupError) { console.warn(`Unvollständige Migration der Phase „${oldName}“ konnte nicht bereinigt werden.`, cleanupError); }
        }
        console.warn(`Die Phase „${oldName}“ konnte nicht automatisch in „${newName}“ umbenannt werden.`, error);
      }
    }
    if (phaseEntries.length === 0) {
      for (const name of defaultPhaseNames()) {
        phaseEntries.push([name, await rootHandle.getDirectoryHandle(name, { create: true })]);
      }
    }
    for (const [name, handle] of phaseEntries) {
      const phase = { name, handle };
      phases.push(phase);
      for await (const [taskName, taskHandle] of handle.entries()) {
        if (taskHandle.kind !== 'directory' || taskName.startsWith('.')) continue;
        try { tasks.push(await readTask(taskHandle, name)); }
        catch (error) { console.warn(`Aufgabe „${taskName}“ wurde übersprungen.`, error); }
      }
    }
    const storedOrder = (await readPhaseOrder()).map((name) => migratedPhaseNames.get(name) ?? name);
    taskOrderByPhase = new Map([...taskOrderByPhase].map(([name, order]) => [migratedPhaseNames.get(name) ?? name, order]));
    if (migratedPhaseNames.size) {
      phaseColors = new Map([...phaseColors].map(([name, color]) => [migratedPhaseNames.get(name) ?? name, color]));
      try { await savePhaseOrder(storedOrder.length ? storedOrder : phases.map((phase) => phase.name)); }
      catch (error) { console.warn('Die neue Phasenreihenfolge konnte nicht gespeichert werden.', error); }
    }
    const phaseOrder = new Map(storedOrder.map((name, index) => [name, index]));
    const defaultOrder = new Map(defaultPhaseNames().map((name, index) => [name, index]));
    phases.sort((a, b) => {
      const aOrder = phaseOrder.get(a.name);
      const bOrder = phaseOrder.get(b.name);
      if (aOrder !== undefined || bOrder !== undefined) return (aOrder ?? Number.MAX_SAFE_INTEGER) - (bOrder ?? Number.MAX_SAFE_INTEGER);
      if (storedOrder.length === 0) {
        const aDefault = defaultOrder.get(a.name);
        const bDefault = defaultOrder.get(b.name);
        if (aDefault !== undefined || bDefault !== undefined) return (aDefault ?? Number.MAX_SAFE_INTEGER) - (bDefault ?? Number.MAX_SAFE_INTEGER);
      }
      return a.name.localeCompare(b.name, 'de');
    });
    tasks.sort((a, b) => a.title.localeCompare(b.title, 'de'));
    for (const phase of phases) {
      const phaseTasks = tasks.filter((task) => task.phase === phase.name);
      const storedTaskOrder = taskOrderByPhase.get(phase.name) ?? [];
      const taskRank = new Map(storedTaskOrder.map((name, index) => [name, index]));
      phaseTasks.sort((a, b) => {
        const aRank = taskRank.get(a.folderName);
        const bRank = taskRank.get(b.folderName);
        if (aRank !== undefined || bRank !== undefined) return (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER);
        return a.title.localeCompare(b.title, 'de');
      });
      taskOrderByPhase.set(phase.name, phaseTasks.map((task) => task.folderName));
    }
    renderBoard();
    await updateTrashButton();
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function markdownDataReferences(markdown) {
    const references = new Set();
    const pattern = /!?\[[^\]]*\]\((?:<)?([^\s)>]+)(?:>)?(?:\s+["'][^"']*["'])?\)/g;
    const prose = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    for (const match of prose.matchAll(pattern)) {
      let target = match[1];
      try { target = decodeURIComponent(target); } catch { continue; }
      const prefix = `${dataDirectoryName}/`;
      if (!target.startsWith(prefix)) continue;
      const name = target.slice(prefix.length);
      if (name && !name.includes('/') && name !== '.' && name !== '..') references.add(name);
    }
    return references;
  }

  function releaseRenderedImages() {
    renderedImageUrls.forEach((url) => URL.revokeObjectURL(url));
    renderedImageUrls = [];
  }

  async function loadTaskImageUrls(task, markdown) {
    const urls = new Map();
    if (!task) return urls;
    const references = markdownDataReferences(markdown);
    if (references.size === 0) return urls;
    try {
      const dataDirectory = await task.handle.getDirectoryHandle(dataDirectoryName);
      for (const name of references) {
        try {
          const file = await (await dataDirectory.getFileHandle(name)).getFile();
          const url = URL.createObjectURL(file);
          urls.set(`${dataDirectoryName}/${encodeURIComponent(name)}`, url);
          urls.set(`${dataDirectoryName}/${name}`, url);
        } catch (error) {
          if (error.name !== 'NotFoundError') console.warn(`Bild „${name}“ konnte nicht geladen werden.`, error);
        }
      }
    } catch (error) {
      if (error.name !== 'NotFoundError') console.warn('Bildordner konnte nicht geöffnet werden.', error);
    }
    return urls;
  }

  function revokeImageMap(urls) {
    for (const url of new Set(urls.values())) URL.revokeObjectURL(url);
  }

  function appendInlineMarkdown(parent, text, imageUrls = new Map()) {
    const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|(?<![\w@])((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
      if (match[1] !== undefined) {
        let imageTarget = match[2];
        try { imageTarget = decodeURIComponent(imageTarget); } catch { imageTarget = ''; }
        const imageUrl = imageUrls.get(imageTarget);
        if (imageUrl) {
          const image = makeElement('img');
          image.src = imageUrl;
          image.alt = match[1];
          image.loading = 'lazy';
          if (match[3]) image.title = match[3];
          parent.append(image);
        } else {
          parent.append(document.createTextNode(match[0]));
        }
      } else if (match[4] !== undefined) {
        const link = makeElement('a', '', match[4]);
        const target = match[5];
        const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(target);
        let safe = !hasScheme;
        if (hasScheme) {
          try { safe = ['http:', 'https:', 'mailto:'].includes(new URL(target, window.location.href).protocol); }
          catch { safe = false; }
        }
        if (safe) {
          const dataUrl = imageUrls.get(target);
          link.href = dataUrl ?? target;
          if (dataUrl) {
            try { link.download = decodeURIComponent(target.slice(target.lastIndexOf('/') + 1)); }
            catch { link.download = target.slice(target.lastIndexOf('/') + 1); }
          } else if (/^https?:/i.test(target)) {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
          }
          parent.append(link);
        } else {
          parent.append(document.createTextNode(match[0]));
        }
      } else if (match[7] !== undefined) {
        parent.append(makeElement('code', '', match[7]));
      } else if (match[8] !== undefined || match[9] !== undefined) {
        parent.append(makeElement('strong', '', match[8] ?? match[9]));
      } else if (match[10] !== undefined) {
        parent.append(makeElement('del', '', match[10]));
      } else if (match[13] !== undefined) {
        let target = match[13];
        let trailing = '';
        while (/[.,!?;:]$/.test(target)) {
          trailing = target.slice(-1) + trailing;
          target = target.slice(0, -1);
        }
        for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
          const openingCount = [...target].filter((character) => character === opening).length;
          let closingCount = [...target].filter((character) => character === closing).length;
          while (closingCount > openingCount && target.endsWith(closing)) {
            target = target.slice(0, -1);
            trailing = closing + trailing;
            closingCount -= 1;
          }
        }
        if (target) {
          const link = makeElement('a', '', target);
          link.href = /^www\./i.test(target) ? `https://${target}` : target;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          parent.append(link);
        }
        if (trailing) parent.append(document.createTextNode(trailing));
      } else {
        parent.append(makeElement('em', '', match[11] ?? match[12]));
      }
      cursor = match.index + match[0].length;
    }
    parent.append(document.createTextNode(text.slice(cursor)));
  }

  function renderMarkdown(markdown, imageUrls = new Map()) {
    const fragment = document.createDocumentFragment();
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let index = 0;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const node = makeElement('p');
      paragraph.forEach((line, lineIndex) => {
        if (lineIndex) node.append(document.createElement('br'));
        appendInlineMarkdown(node, line, imageUrls);
      });
      fragment.append(node);
      paragraph = [];
    };
    const isUnorderedItem = (line) => /^\s*[-+*]\s+/.test(line);
    const isOrderedItem = (line) => /^\s*\d+[.)]\s+/.test(line);
    const isTableDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { flushParagraph(); index += 1; continue; }

      const fence = line.match(/^\s*```/);
      if (fence) {
        flushParagraph();
        index += 1;
        const codeLines = [];
        while (index < lines.length && !/^\s*```/.test(lines[index])) codeLines.push(lines[index++]);
        if (index < lines.length) index += 1;
        const pre = makeElement('pre');
        pre.append(makeElement('code', '', codeLines.join('\n')));
        fragment.append(pre);
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        const node = makeElement(`h${heading[1].length}`);
        appendInlineMarkdown(node, heading[2], imageUrls);
        fragment.append(node);
        index += 1;
        continue;
      }

      if (/^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
        flushParagraph();
        fragment.append(document.createElement('hr'));
        index += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        flushParagraph();
        const quoteLines = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) quoteLines.push(lines[index++].replace(/^\s*>\s?/, ''));
        const quote = makeElement('blockquote');
        quote.append(renderMarkdown(quoteLines.join('\n'), imageUrls));
        fragment.append(quote);
        continue;
      }

      if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
        flushParagraph();
        const table = makeElement('table');
        const head = makeElement('thead');
        const headerRow = makeElement('tr');
        tableCells(line).forEach((cell) => {
          const th = makeElement('th');
          appendInlineMarkdown(th, cell, imageUrls);
          headerRow.append(th);
        });
        head.append(headerRow);
        table.append(head);
        index += 2;
        const body = makeElement('tbody');
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          const row = makeElement('tr');
          tableCells(lines[index++]).forEach((cell) => {
            const td = makeElement('td');
            appendInlineMarkdown(td, cell, imageUrls);
            row.append(td);
          });
          body.append(row);
        }
        table.append(body);
        const wrapper = makeElement('div', 'markdown-table-wrap');
        wrapper.append(table);
        fragment.append(wrapper);
        continue;
      }

      if (isUnorderedItem(line) || isOrderedItem(line)) {
        flushParagraph();
        const ordered = isOrderedItem(line);
        const list = makeElement(ordered ? 'ol' : 'ul');
        while (index < lines.length && (ordered ? isOrderedItem(lines[index]) : isUnorderedItem(lines[index]))) {
          const itemText = lines[index++].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-+*]\s+/, '');
          const taskItem = !ordered && itemText.match(/^\[([ xX])\]\s+(.*)$/);
          const item = makeElement('li');
          if (taskItem) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.disabled = true;
            checkbox.checked = taskItem[1].toLowerCase() === 'x';
            checkbox.setAttribute('aria-label', checkbox.checked ? 'Erledigt' : 'Offen');
            item.append(checkbox);
            appendInlineMarkdown(item, taskItem[2], imageUrls);
          } else appendInlineMarkdown(item, itemText, imageUrls);
          list.append(item);
        }
        fragment.append(list);
        continue;
      }

      paragraph.push(line);
      index += 1;
    }
    flushParagraph();
    return fragment;
  }

  function setTaskDialogMode(mode) {
    const viewing = mode === 'view';
    $('#task-view').hidden = !viewing;
    $('#task-edit-fields').hidden = viewing;
    $('#editor-actions').hidden = viewing;
    $('#dialog-title').textContent = viewing ? editingTask.title : (editingTask ? t('editTaskTitle') : t('newTaskTitle'));
    taskForm.querySelector('button[type="submit"]').textContent = t(editingTask ? 'change' : 'createTask');
    if (viewing) {
      $('#task-view-phase').textContent = t('phaseLabel', { phase: phaseDisplayName(editingTask.phase) });
      const priorityBadge = $('#task-view-priority');
      priorityBadge.textContent = t(`priority${editingTask.priority[0].toUpperCase()}${editingTask.priority.slice(1)}`);
      priorityBadge.className = `priority-badge priority-${editingTask.priority}`;
      priorityBadge.setAttribute('aria-label', t('taskPriorityAria', {
        priority: priorityBadge.textContent,
      }));
      $('#task-view-created').textContent = formatTaskCreatedDate(editingTask.createdAt);
      renderTaskTags($('#task-view-tags'), editingTask.tags);
      const rendered = $('#markdown-rendered');
      rendered.replaceChildren(makeElement('p', 'markdown-empty', t('loadingDescription')));
      renderTaskSubtasks(editingTask);
      renderTaskComments(editingTask);
      void renderTaskDetails(editingTask);
    } else {
      releaseRenderedImages();
    }
  }

  function formatTaskCreatedDate(timestamp) {
    if (!Number.isFinite(timestamp)) return t('unknownCreatedDate');
    return t('createdDate', { date: new Date(timestamp).toLocaleDateString(languageCatalog.locale, { dateStyle: 'medium' }) });
  }

  async function renderTaskDetails(task) {
    releaseRenderedImages();
    const imageUrls = await loadTaskImageUrls(task, task.details);
    if (editingTask !== task || $('#task-view').hidden) {
      revokeImageMap(imageUrls);
      return;
    }
    renderedImageUrls = [...new Set(imageUrls.values())];
    const rendered = $('#markdown-rendered');
    rendered.replaceChildren();
    if (task.details.trim()) rendered.append(renderMarkdown(task.details, imageUrls));
    else rendered.append(makeElement('p', 'markdown-empty', t('noDescription')));
  }

  function formatCommentDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(languageCatalog.locale, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderTaskComments(task) {
    const list = $('#comments-list');
    list.replaceChildren();
    const comments = task.comments ?? [];
    $('#comment-count').textContent = String(comments.length);
    if (!comments.length) {
      list.append(makeElement('p', 'comments-empty', t('noComments')));
      return;
    }
    for (const comment of comments) {
      const card = makeElement('article', 'comment-card');
      const header = makeElement('div', 'comment-card-header');
      const date = formatCommentDate(comment.createdAt);
      const updated = comment.updatedAt && comment.updatedAt !== comment.createdAt ? ` · ${t('edited')}` : '';
      header.append(makeElement('span', 'comment-date', `${date}${updated}`));
      const actions = makeElement('div', 'comment-actions');
      const editButton = makeElement('button', 'comment-action', t('edit'));
      editButton.type = 'button';
      editButton.addEventListener('click', () => editCommentInPlace(task, comment));
      const deleteButton = makeElement('button', 'comment-action comment-delete', t('delete'));
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', () => deleteTaskComment(task, comment.id));
      actions.append(editButton, deleteButton);
      header.append(actions);
      const body = makeElement('div', 'comment-body markdown-rendered');
      body.append(renderMarkdown(comment.text));
      card.append(header, body);
      list.append(card);
    }
  }

  function renderTaskSubtasks(task) {
    const list = $('#subtasks-list');
    const subtasks = task.subtasks ?? [];
    const completedCount = subtasks.filter((subtask) => subtask.completed).length;
    if (!completedCount) hideCompletedSubtasks = false;
    $('#subtask-count').textContent = `${completedCount}/${subtasks.length}`;
    const visibilityButton = $('#toggle-completed-subtasks');
    const visibilityLabel = t(hideCompletedSubtasks ? 'showCompletedSubtasks' : 'hideCompletedSubtasks');
    visibilityButton.hidden = !completedCount;
    visibilityButton.textContent = visibilityLabel;
    visibilityButton.title = visibilityLabel;
    visibilityButton.setAttribute('aria-label', visibilityLabel);
    visibilityButton.setAttribute('aria-pressed', String(hideCompletedSubtasks));
    list.replaceChildren();
    if (!subtasks.length) list.append(makeElement('p', 'comments-empty', t('noSubtasks')));
    subtasks.forEach((subtask, index) => {
      if (hideCompletedSubtasks && subtask.completed) return;
      const item = makeElement('div', `subtask-item${subtask.completed ? ' subtask-completed' : ''}`);
      const dragHandle = makeElement('span', 'subtask-drag-handle', '⠿');
      attachSubtaskDrag(item, dragHandle, index, list, subtasks, () => !task.subtasksSaving, (updated) => {
        void saveTaskSubtasks(task, updated);
      });
      const main = makeElement('label', 'subtask-main');
      const checkbox = makeElement('input', 'subtask-checkbox');
      checkbox.type = 'checkbox';
      checkbox.checked = subtask.completed;
      checkbox.disabled = Boolean(task.subtasksSaving);
      checkbox.setAttribute('aria-label', `${t(subtask.completed ? 'markOpen' : 'checkOff')}: ${subtask.text}`);
      checkbox.addEventListener('change', () => {
        const updated = subtasks.map((entry, entryIndex) => entryIndex === index ? { ...entry, completed: checkbox.checked } : entry);
        void saveTaskSubtasks(task, updated);
      });
      main.append(checkbox, makeElement('span', 'subtask-text', subtask.text));
      const actions = makeElement('div', 'subtask-actions');
      const editButton = makeElement('button', 'comment-action', t('edit'));
      editButton.type = 'button';
      editButton.disabled = Boolean(task.subtasksSaving);
      editButton.setAttribute('aria-label', t('editSubtaskAria', { text: subtask.text }));
      editButton.addEventListener('click', () => editTaskSubtaskInPlace(task, index));
      const deleteButton = makeElement('button', 'comment-action comment-delete', t('delete'));
      deleteButton.type = 'button';
      deleteButton.disabled = Boolean(task.subtasksSaving);
      deleteButton.setAttribute('aria-label', t('deleteSubtaskAria', { text: subtask.text }));
      deleteButton.addEventListener('click', () => deleteTaskSubtask(task, index));
      actions.append(editButton, deleteButton);
      item.append(dragHandle, main, actions);
      list.append(item);
    });
    $('#new-subtask').disabled = Boolean(task.subtasksSaving);
    $('#add-subtask').disabled = Boolean(task.subtasksSaving);
  }

  function attachSubtaskDrag(item, handle, index, list, subtasks, canReorder, onReorder) {
    const dragType = 'application/x-kanbanraum-subtask';
    handle.draggable = canReorder();
    handle.title = t('subtaskDrag');
    handle.setAttribute('aria-label', t('subtaskMoveAria', { text: subtasks[index].text }));
    handle.addEventListener('dragstart', (event) => {
      if (!canReorder()) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData(dragType, `${list.id}:${index}`);
      event.dataTransfer.effectAllowed = 'move';
      item.classList.add('subtask-dragging');
    });
    handle.addEventListener('dragend', () => {
      list.querySelectorAll('.subtask-item').forEach((entry) => {
        entry.classList.remove('subtask-dragging', 'subtask-drop-before', 'subtask-drop-after');
      });
    });
    item.addEventListener('dragover', (event) => {
      if (!canReorder() || !event.dataTransfer.types.includes(dragType)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const after = event.clientY >= item.getBoundingClientRect().top + item.offsetHeight / 2;
      item.classList.toggle('subtask-drop-before', !after);
      item.classList.toggle('subtask-drop-after', after);
    });
    item.addEventListener('dragleave', (event) => {
      if (!item.contains(event.relatedTarget)) item.classList.remove('subtask-drop-before', 'subtask-drop-after');
    });
    item.addEventListener('drop', (event) => {
      if (!canReorder() || !event.dataTransfer.types.includes(dragType)) return;
      event.preventDefault();
      const [sourceListId, sourceIndexText] = event.dataTransfer.getData(dragType).split(':');
      const sourceIndex = Number(sourceIndexText);
      if (sourceListId !== list.id || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= subtasks.length) return;
      const after = event.clientY >= item.getBoundingClientRect().top + item.offsetHeight / 2;
      let destinationIndex = index + Number(after);
      if (sourceIndex < destinationIndex) destinationIndex -= 1;
      if (sourceIndex === destinationIndex) return;
      const updated = [...subtasks];
      const [movedSubtask] = updated.splice(sourceIndex, 1);
      updated.splice(destinationIndex, 0, movedSubtask);
      list.querySelectorAll('.subtask-item').forEach((entry) => {
        entry.classList.remove('subtask-dragging', 'subtask-drop-before', 'subtask-drop-after');
      });
      onReorder(updated);
    });
  }

  function editTaskSubtaskInPlace(task, index) {
    if (task.subtasksSaving) return;
    const item = $('#subtasks-list').querySelectorAll('.subtask-item')[index];
    const subtask = task.subtasks[index];
    if (!item || !subtask) return;
    const editor = makeElement('div', 'subtask-editor');
    const input = makeElement('input', 'text-input subtask-input');
    input.type = 'text';
    input.maxLength = 180;
    input.value = subtask.text;
    input.setAttribute('aria-label', t('editSubtaskLabel'));
    const actions = makeElement('div', 'subtask-edit-actions');
    const cancel = makeElement('button', 'button button-secondary', t('cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => renderTaskSubtasks(task));
    const save = makeElement('button', 'button button-primary', t('save'));
    save.type = 'button';
    save.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) {
        showToast(t('subtaskEmptyError'));
        input.focus();
        return;
      }
      const updated = task.subtasks.map((entry, entryIndex) => entryIndex === index ? { ...entry, text } : entry);
      void saveTaskSubtasks(task, updated, t('subtaskChanged'));
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renderTaskSubtasks(task);
      }
    });
    actions.append(cancel, save);
    editor.append(input, actions);
    item.replaceWith(editor);
    input.focus();
    input.select();
  }

  async function deleteTaskSubtask(task, index) {
    const subtask = task.subtasks[index];
    if (!subtask || task.subtasksSaving) return;
    if (!window.confirm(t('subtaskDeleteConfirm', { text: subtask.text }))) return;
    const updated = task.subtasks.filter((_, entryIndex) => entryIndex !== index);
    await saveTaskSubtasks(task, updated, t('subtaskDeleted'));
  }

  async function saveTaskSubtasks(task, subtasks, successMessage = '') {
    task.subtasksSaving = true;
    renderTaskSubtasks(task);
    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      await writeSubtasks(task.handle, subtasks);
      task.subtasks = subtasks;
      if (successMessage) showToast(successMessage);
      return true;
    } catch (error) {
      showToast(t('subtaskSaveError', { error: error.message }));
      return false;
    } finally {
      task.subtasksSaving = false;
      if (editingTask === task && !$('#task-view').hidden) renderTaskSubtasks(task);
    }
  }

  async function addTaskSubtask() {
    if (!editingTask || $('#task-view').hidden) return;
    const input = $('#new-subtask');
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    const subtasks = [...(editingTask.subtasks ?? []), { text, completed: false }];
    if (await saveTaskSubtasks(editingTask, subtasks, t('subtaskAdded'))) input.value = '';
  }

  function renderDraftTaskSubtasks() {
    const list = $('#draft-subtasks-list');
    const completedCount = draftSubtasks.filter((subtask) => subtask.completed).length;
    $('#draft-subtask-count').textContent = `${completedCount}/${draftSubtasks.length}`;
    list.replaceChildren();
    if (!draftSubtasks.length) list.append(makeElement('p', 'comments-empty', t('noSubtasks')));
    draftSubtasks.forEach((subtask, index) => {
      const item = makeElement('div', `subtask-item${subtask.completed ? ' subtask-completed' : ''}`);
      const dragHandle = makeElement('span', 'subtask-drag-handle', '⠿');
      attachSubtaskDrag(item, dragHandle, index, list, draftSubtasks, () => !draftSubtasksSaving, (updated) => {
        draftSubtasks = updated;
        renderDraftTaskSubtasks();
      });
      const main = makeElement('label', 'subtask-main');
      const checkbox = makeElement('input', 'subtask-checkbox');
      checkbox.type = 'checkbox';
      checkbox.checked = subtask.completed;
      checkbox.disabled = draftSubtasksSaving;
      checkbox.setAttribute('aria-label', `${t(subtask.completed ? 'markOpen' : 'checkOff')}: ${subtask.text}`);
      checkbox.addEventListener('change', () => {
        draftSubtasks = draftSubtasks.map((entry, entryIndex) => entryIndex === index ? { ...entry, completed: checkbox.checked } : entry);
        renderDraftTaskSubtasks();
      });
      main.append(checkbox, makeElement('span', 'subtask-text', subtask.text));
      const actions = makeElement('div', 'subtask-actions');
      const editButton = makeElement('button', 'comment-action', t('edit'));
      editButton.type = 'button';
      editButton.disabled = draftSubtasksSaving;
      editButton.setAttribute('aria-label', t('editSubtaskAria', { text: subtask.text }));
      editButton.addEventListener('click', () => editDraftTaskSubtaskInPlace(index));
      const removeButton = makeElement('button', 'comment-action comment-delete', t('remove'));
      removeButton.type = 'button';
      removeButton.disabled = draftSubtasksSaving;
      removeButton.setAttribute('aria-label', t('removeDraftSubtaskAria', { text: subtask.text }));
      removeButton.addEventListener('click', () => {
        draftSubtasks = draftSubtasks.filter((_, entryIndex) => entryIndex !== index);
        renderDraftTaskSubtasks();
      });
      actions.append(editButton, removeButton);
      item.append(dragHandle, main, actions);
      list.append(item);
    });
    $('#new-draft-subtask').disabled = draftSubtasksSaving;
    $('#add-draft-subtask').disabled = draftSubtasksSaving;
  }

  function editDraftTaskSubtaskInPlace(index) {
    if (draftSubtasksSaving) return;
    const item = $('#draft-subtasks-list').querySelectorAll('.subtask-item')[index];
    const subtask = draftSubtasks[index];
    if (!item || !subtask) return;
    const editor = makeElement('div', 'subtask-editor');
    const input = makeElement('input', 'text-input subtask-input');
    input.type = 'text';
    input.maxLength = 180;
    input.value = subtask.text;
    input.setAttribute('aria-label', t('editSubtaskLabel'));
    const actions = makeElement('div', 'subtask-edit-actions');
    const cancel = makeElement('button', 'button button-secondary', t('cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', renderDraftTaskSubtasks);
    const apply = makeElement('button', 'button button-primary', t('apply'));
    apply.type = 'button';
    apply.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) {
        showToast(t('subtaskEmptyError'));
        input.focus();
        return;
      }
      draftSubtasks = draftSubtasks.map((entry, entryIndex) => entryIndex === index ? { ...entry, text } : entry);
      renderDraftTaskSubtasks();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        apply.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renderDraftTaskSubtasks();
      }
    });
    actions.append(cancel, apply);
    editor.append(input, actions);
    item.replaceWith(editor);
    input.focus();
    input.select();
  }

  function addDraftTaskSubtask() {
    if (draftSubtasksSaving) return;
    const input = $('#new-draft-subtask');
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    draftSubtasks.push({ text, completed: false });
    input.value = '';
    renderDraftTaskSubtasks();
    input.focus();
  }

  function editCommentInPlace(task, comment) {
    const list = $('#comments-list');
    const cards = [...list.children];
    const commentIndex = (task.comments ?? []).findIndex((entry) => entry.id === comment.id);
    if (commentIndex < 0) return;
    const card = cards[commentIndex];
    if (!card) return;
    const editor = makeElement('div', 'comment-edit');
    const textarea = makeElement('textarea', 'text-input comment-input');
    textarea.value = comment.text;
    textarea.rows = 4;
    textarea.maxLength = 10000;
    textarea.setAttribute('aria-label', t('commentEditAria'));
    const actions = makeElement('div', 'comment-form-actions');
    const cancel = makeElement('button', 'button button-secondary', t('cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => renderTaskComments(task));
    const save = makeElement('button', 'button button-primary', t('saveChanges'));
    save.type = 'button';
    save.addEventListener('click', () => {
      const text = textarea.value.trim();
      if (!text) {
        showToast(t('commentEmptyError'));
        textarea.focus();
        return;
      }
      const updatedAt = new Date().toISOString();
      const comments = task.comments.map((entry) => entry.id === comment.id ? { ...entry, text, updatedAt } : entry);
      void saveTaskComments(task, comments, t('commentChanged'));
    });
    actions.append(cancel, save);
    editor.append(textarea, actions);
    card.replaceChildren(editor);
    textarea.focus();
  }

  async function saveTaskComments(task, comments, successMessage) {
    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      await writeComments(task.handle, comments);
      task.comments = comments;
      renderTaskComments(task);
      showToast(successMessage);
    } catch (error) {
      showToast(t('commentSaveError', { error: error.message }));
    }
  }

  async function addTaskComment() {
    if (!editingTask) return;
    const textarea = $('#new-comment');
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }
    const now = new Date().toISOString();
    const id = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const comments = [...(editingTask.comments ?? []), { id, createdAt: now, updatedAt: now, text }];
    await saveTaskComments(editingTask, comments, t('commentAdded'));
    if (editingTask.comments?.some((comment) => comment.id === id)) textarea.value = '';
  }

  async function deleteTaskComment(task, commentId) {
    const comment = (task.comments ?? []).find((entry) => entry.id === commentId);
    if (!comment || !window.confirm(t('commentDeleteConfirm'))) return;
    const comments = task.comments.filter((entry) => entry.id !== commentId);
    await saveTaskComments(task, comments, t('commentDeleted'));
  }

  function renderBoard() {
    const query = $('#search-input').value.trim().toLocaleLowerCase();
    updateOverviewPhaseOptions();
    updateOverviewTagOptions();
    const selectedPhase = currentView === 'overview' ? $('#overview-phase-filter').value : '';
    const selectedPriority = currentView === 'overview' ? $('#overview-priority-filter').value : '';
    const selectedTag = currentView === 'overview' ? $('#overview-tag-filter').value : '';
    const visibleTasks = tasks.filter((task) =>
      (!selectedPhase || task.phase === selectedPhase)
      && (!selectedPriority || task.priority === selectedPriority)
      && (!selectedTag || (task.tags ?? []).some((tag) => tag.toLocaleLowerCase() === selectedTag))
      && `${task.title} ${task.details} ${task.phase} ${(task.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(query));
    const projectName = rootHandle
      ? activeBoardName()
      : projectHandle
        ? t('noBoardSelectedTitle')
        : t('boardTitle');
    $('#board-title').textContent = projectName;
    $('#board-breadcrumb-project').textContent = rootHandle ? activeBoardName() : '';
    $('#board-breadcrumb-project').hidden = !rootHandle;
    $('#project-crumb-separator').hidden = !rootHandle;
    $('#view-crumb-separator').hidden = !rootHandle;
    $('#board-breadcrumb-title').textContent = currentView === 'overview' ? t('navOverview') : t('boardTitle');
    $('#board-breadcrumb-title').hidden = !rootHandle;
    board.replaceChildren();
    board.classList.toggle('task-overview', currentView === 'overview');
    board.hidden = !rootHandle;
    welcomePanel.hidden = Boolean(rootHandle);
    $('#welcome-panel h2').textContent = projectHandle && !rootHandle ? t('noBoardSelectedTitle') : t('welcomeTitle');
    $('#welcome-panel .welcome-copy > p').textContent = projectHandle && !rootHandle ? t('noBoardSelectedText') : t('welcomeText');
    $('#welcome-open').hidden = Boolean(projectHandle);
    $('#restore-folder').hidden = Boolean(projectHandle) || !savedRootHandle;
    $('#new-task-button').disabled = !rootHandle || phases.length === 0;
    $('#new-phase-button').disabled = !rootHandle;
    $('#delete-board-button').disabled = !rootHandle;
    $('#board-status').textContent = rootHandle
      ? t(phases.length === 1 ? (tasks.length === 1 ? 'phaseTaskCountOne' : 'phaseTaskCountMany') : (tasks.length === 1 ? 'phasesTaskCountOne' : 'phasesTaskCountMany'), { phases: phases.length, tasks: tasks.length })
      : projectHandle ? t('noBoardActive') : t('noProject');
    $('#overview-filters').hidden = !rootHandle || currentView !== 'overview';

    if (currentView === 'overview') {
      for (const task of visibleTasks) board.append(createTaskCard(task, true));
      $('#empty-search').textContent = query
        ? t('noOverviewSearchResults')
        : selectedPhase || selectedPriority || selectedTag
          ? t('noOverviewFilterResults')
          : t('noProjectTasks');
      $('#empty-search').hidden = !rootHandle || visibleTasks.length > 0;
      return;
    }
    $('#empty-search').hidden = true;

    for (const phase of phases) {
      const column = makeElement('section', 'column');
      column.dataset.phase = phase.name;
      column.addEventListener('dragover', (event) => {
        if (event.dataTransfer.types.includes('text/plain')) {
          event.preventDefault();
          column.classList.add('drag-over');
        }
      });
      column.addEventListener('dragleave', (event) => {
        if (!column.contains(event.relatedTarget)) column.classList.remove('drag-over');
      });
      column.addEventListener('drop', (event) => {
        event.preventDefault();
        column.classList.remove('drag-over');
        const payload = event.dataTransfer.getData('text/plain');
        if (payload.startsWith('phase:')) {
          void movePhase(payload.slice('phase:'.length), phase.name);
          return;
        }
        if (payload.startsWith('task:')) {
          const task = tasks.find((item) => item.id === payload.slice('task:'.length));
          if (task && task.phase === phase.name) {
            void reorderPhaseTasks(phase.name, task.id, null, true);
            return;
          }
          if (task && task.phase !== phase.name) {
            void moveTask(task, phase.name);
            return;
          }
        }
        const taskId = payload;
        const task = tasks.find((item) => item.id === taskId);
        if (task && task.phase !== phase.name) moveTask(task, phase.name);
      });

      const header = makeElement('div', 'column-header');
      const titleWrap = makeElement('div', 'column-title-wrap');
      const dragHandle = makeElement('span', 'phase-drag-handle', '⠿');
      dragHandle.draggable = true;
      dragHandle.title = t('phaseDrag');
      dragHandle.setAttribute('aria-label', t('phaseMoveAria', { phase: phaseDisplayName(phase.name) }));
      dragHandle.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', `phase:${phase.name}`);
        event.dataTransfer.effectAllowed = 'move';
        column.classList.add('phase-dragging');
      });
      dragHandle.addEventListener('dragend', () => {
        document.querySelectorAll('.column').forEach((item) => item.classList.remove('phase-dragging', 'drag-over'));
      });
      const phaseColor = makeElement('span', 'column-color');
      if (phaseColors.has(phase.name)) phaseColor.style.backgroundColor = phaseColors.get(phase.name);
      const colorButton = makeElement('button', 'phase-color-button');
      colorButton.type = 'button';
      colorButton.title = t('phaseColorChange', { phase: phaseDisplayName(phase.name) });
      colorButton.setAttribute('aria-label', colorButton.title);
      const colorInput = makeElement('input', 'phase-color-input');
      colorInput.type = 'color';
      const defaultColors = ['#9993e9', '#e8ae57', '#54b99a'];
      colorInput.value = phaseColors.get(phase.name) ?? defaultColors[phases.indexOf(phase) % defaultColors.length];
      colorInput.setAttribute('aria-label', t('newPhaseColorAria', { phase: phaseDisplayName(phase.name) }));
      colorButton.append(phaseColor);
      colorButton.addEventListener('click', () => {
        try { colorInput.showPicker(); }
        catch { colorInput.click(); }
      });
      colorInput.addEventListener('change', () => changePhaseColor(phase.name, colorInput.value));
      titleWrap.append(dragHandle, colorButton, colorInput, makeElement('span', 'column-title', phaseDisplayName(phase.name)));
      const count = makeElement('span', 'task-count', String(visibleTasks.filter((task) => task.phase === phase.name).length));
      const phaseActions = makeElement('div', 'phase-actions');
      const phaseTasks = tasks.filter((task) => task.phase === phase.name);
      if (isCompletedPhase(phase.name)) {
        const trashAllButton = makeElement('button', 'phase-manage phase-trash-all', '🗑');
        trashAllButton.type = 'button';
        trashAllButton.title = t('phaseTrashAll');
        trashAllButton.setAttribute('aria-label', trashAllButton.title);
        trashAllButton.disabled = phaseTasks.length === 0;
        trashAllButton.addEventListener('click', () => movePhaseTasksToTrash(phase.name));
        phaseActions.append(trashAllButton);
      }
      const renameButton = makeElement('button', 'phase-manage', '✎');
      renameButton.type = 'button';
      renameButton.title = t('phaseRename', { phase: phaseDisplayName(phase.name) });
      renameButton.setAttribute('aria-label', renameButton.title);
      renameButton.addEventListener('click', () => renamePhase(phase.name));
      const deleteButton = makeElement('button', 'phase-manage phase-delete', '×');
      deleteButton.type = 'button';
      deleteButton.title = t('phaseDelete', { phase: phaseDisplayName(phase.name) });
      deleteButton.setAttribute('aria-label', deleteButton.title);
      deleteButton.addEventListener('click', () => deletePhase(phase.name));
      phaseActions.append(renameButton, deleteButton);
      header.append(titleWrap, count, phaseActions);

      const list = makeElement('div', 'task-list');
      const visiblePhaseTasks = orderPhaseTasks(visibleTasks.filter((task) => task.phase === phase.name), phase.name);
      if (!visiblePhaseTasks.length) list.append(makeElement('div', 'empty-column', query ? t('noMatchingTasks') : t('noTasksYet')));
      for (const task of visiblePhaseTasks) list.append(createTaskCard(task));

      const addTask = makeElement('button', 'add-task-inline', t('addTaskInline'));
      addTask.type = 'button';
      addTask.addEventListener('click', () => openTaskDialog(null, phase.name));
      column.append(header, list, addTask);
      board.append(column);
    }
    $('#empty-search').hidden = !(rootHandle && query && visibleTasks.length === 0 && phases.length === 0);
  }

  function updateOverviewPhaseOptions() {
    const select = $('#overview-phase-filter');
    const selected = select.value;
    select.replaceChildren();
    const allPhases = document.createElement('option');
    allPhases.value = '';
    allPhases.textContent = t('allPhases');
    select.append(allPhases);
    for (const phase of phases) {
      const option = document.createElement('option');
      option.value = phase.name;
      option.textContent = phaseDisplayName(phase.name);
      select.append(option);
    }
    select.value = phases.some((phase) => phase.name === selected) ? selected : '';
  }

  async function changePhaseColor(phaseName, color) {
    const previousColor = phaseColors.get(phaseName);
    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      phaseColors.set(phaseName, color);
      await savePhaseOrder(phases.map((phase) => phase.name));
      renderBoard();
      showToast(t('phasePointSaved', { phase: phaseDisplayName(phaseName) }));
    } catch (error) {
      if (previousColor) phaseColors.set(phaseName, previousColor);
      else phaseColors.delete(phaseName);
      renderBoard();
      showToast(t('phasePointSaveError', { error: error.message }));
    }
  }

  function orderPhaseTasks(phaseTasks, phaseName) {
    const taskRank = new Map((taskOrderByPhase.get(phaseName) ?? []).map((name, index) => [name, index]));
    return [...phaseTasks].sort((a, b) => {
      const aRank = taskRank.get(a.folderName);
      const bRank = taskRank.get(b.folderName);
      if (aRank !== undefined || bRank !== undefined) return (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER);
      return a.title.localeCompare(b.title, 'de');
    });
  }

  async function reorderPhaseTasks(phaseName, taskId, targetTaskId, placeAfter = false) {
    const phaseTasks = orderPhaseTasks(tasks.filter((task) => task.phase === phaseName), phaseName);
    const sourceIndex = phaseTasks.findIndex((task) => task.id === taskId);
    if (sourceIndex < 0) return;
    const [movingTask] = phaseTasks.splice(sourceIndex, 1);
    let destinationIndex = targetTaskId
      ? phaseTasks.findIndex((task) => task.id === targetTaskId)
      : phaseTasks.length;
    if (destinationIndex < 0) return;
    if (placeAfter && targetTaskId) destinationIndex += 1;
    phaseTasks.splice(destinationIndex, 0, movingTask);
    const previousOrder = taskOrderByPhase.get(phaseName) ?? [];
    const nextOrder = phaseTasks.map((task) => task.folderName);
    if (nextOrder.every((name, index) => name === previousOrder[index]) && nextOrder.length === previousOrder.length) return;
    taskOrderByPhase.set(phaseName, nextOrder);
    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      await savePhaseOrder(phases.map((phase) => phase.name));
      renderBoard();
    } catch (error) {
      taskOrderByPhase.set(phaseName, previousOrder);
      renderBoard();
      showToast(t('taskOrderSaveError', { error: error.message }));
    }
  }

  async function movePhase(sourceName, targetName) {
    if (sourceName === targetName) return;
    const sourceIndex = phases.findIndex((phase) => phase.name === sourceName);
    const targetIndex = phases.findIndex((phase) => phase.name === targetName);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const reordered = [...phases];
    const [moving] = reordered.splice(sourceIndex, 1);
    reordered.splice(reordered.findIndex((phase) => phase.name === targetName), 0, moving);
    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      await savePhaseOrder(reordered.map((phase) => phase.name));
      phases = reordered;
      renderBoard();
    } catch (error) {
      showToast(t('phaseOrderSaveError', { error: error.message }));
    }
  }

  function createTaskCard(task, showPhase = false) {
    const card = makeElement('article', 'task-card');
    card.draggable = true;
    card.tabIndex = 0;
    card.setAttribute('aria-label', t('taskCardAria', { title: task.title, phase: phaseDisplayName(task.phase) }));
    card.addEventListener('dragstart', (event) => {
      draggedTask = task;
      event.dataTransfer.setData('application/x-kanbanraum-task', task.id);
      event.dataTransfer.setData('text/plain', `task:${task.id}`);
      event.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    card.addEventListener('dragend', () => {
      draggedTask = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.task-drop-before, .task-drop-after').forEach((item) => {
        item.classList.remove('task-drop-before', 'task-drop-after');
      });
    });
    if (!showPhase) {
      card.addEventListener('dragover', (event) => {
        if (!event.dataTransfer.types.includes('application/x-kanbanraum-task')) return;
        const sourceTask = draggedTask;
        if (!sourceTask || sourceTask.phase !== task.phase || sourceTask.id === task.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const after = event.clientY >= card.getBoundingClientRect().top + card.offsetHeight / 2;
        card.classList.toggle('task-drop-before', !after);
        card.classList.toggle('task-drop-after', after);
      });
      card.addEventListener('dragleave', (event) => {
        if (!card.contains(event.relatedTarget)) card.classList.remove('task-drop-before', 'task-drop-after');
      });
      card.addEventListener('drop', (event) => {
        if (!event.dataTransfer.types.includes('application/x-kanbanraum-task')) return;
        const payload = event.dataTransfer.getData('text/plain');
        if (!payload.startsWith('task:')) return;
        const sourceTask = tasks.find((item) => item.id === payload.slice('task:'.length));
        if (!sourceTask || sourceTask.phase !== task.phase) return;
        event.preventDefault();
        event.stopPropagation();
        const after = event.clientY >= card.getBoundingClientRect().top + card.offsetHeight / 2;
        card.classList.remove('task-drop-before', 'task-drop-after');
        void reorderPhaseTasks(task.phase, sourceTask.id, task.id, after);
      });
    }
    card.addEventListener('click', () => openTaskDialog(task));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTaskDialog(task); }
    });

    card.append(makeElement('h3', 'task-title', task.title));
    const excerpt = task.details.replace(/^#+\s*/gm, '').replace(/[\*_`~]/g, '').replace(/\n+/g, ' ').trim();
    if (excerpt) card.append(makeElement('p', 'task-description', excerpt));
    if (task.tags?.length) {
      const tags = makeElement('div', 'task-tags');
      renderTaskTags(tags, task.tags);
      card.append(tags);
    }
    const meta = makeElement('div', 'task-meta');
    const subtasks = task.subtasks ?? [];
    const completedSubtasks = subtasks.filter((subtask) => subtask.completed).length;
    const subtaskLabel = makeElement('span', 'task-meta-label');
    subtaskLabel.append(makeElement('span', '', '☑'), document.createTextNode(t('subtaskCount', { done: completedSubtasks, total: subtasks.length })));
    meta.append(subtaskLabel);
    const priorityMeta = makeElement('span', 'priority-meta');
    priorityMeta.append(makeElement('span', 'priority-label', t('priorityLabel')));
    const priorityBadge = makeElement('span', `priority-badge priority-${task.priority}`, t(`priority${task.priority[0].toUpperCase()}${task.priority.slice(1)}`));
    priorityBadge.setAttribute('aria-label', t('taskPriorityAria', { priority: priorityBadge.textContent }));
    priorityMeta.append(priorityBadge);
    meta.append(priorityMeta);
    if (showPhase) meta.append(makeElement('span', 'task-phase-badge', phaseDisplayName(task.phase)));
    else meta.append(makeElement('span', '', '↗'));
    card.append(meta);
    return card;
  }

  function renderTaskTags(container, tags) {
    const normalizedTags = normalizeTaskTags(tags);
    container.replaceChildren();
    container.hidden = normalizedTags.length === 0;
    normalizedTags.forEach((tag) => container.append(makeElement('span', 'task-tag', tag)));
  }

  function updatePhaseOptions(selectedName) {
    const select = $('#task-phase');
    select.replaceChildren();
    phases.forEach((phase) => {
      const option = document.createElement('option');
      option.value = phase.name;
      option.textContent = phaseDisplayName(phase.name);
      option.selected = phase.name === selectedName;
      select.append(option);
    });
  }

  function updateOverviewTagOptions() {
    const select = $('#overview-tag-filter');
    const selectedTag = select.value;
    const tagsByKey = new Map();
    tasks.forEach((task) => (task.tags ?? []).forEach((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tagsByKey.has(key)) tagsByKey.set(key, tag);
    }));
    const tags = [...tagsByKey.entries()]
      .sort((left, right) => left[1].localeCompare(right[1], languageCatalog.locale, { sensitivity: 'base' }));
    select.replaceChildren();
    const allTagsOption = document.createElement('option');
    allTagsOption.value = '';
    allTagsOption.textContent = t('allTags');
    select.append(allTagsOption);
    tags.forEach(([key, tag]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = tag;
      select.append(option);
    });
    select.value = tagsByKey.has(selectedTag) ? selectedTag : '';
  }

  function openTaskDialog(task = null, phaseName = phases[0]?.name, mode = task ? 'view' : 'edit') {
    if (!phases.length) {
      showToast(t('noPhaseFirst'));
      return;
    }
    pendingFiles = new Map();
    hideCompletedSubtasks = false;
    draftSubtasks = [];
    draftSubtasksSaving = false;
    $('#attachment-picker').value = '';
    $('#new-draft-subtask').value = '';
    $('#new-task-subtasks').hidden = Boolean(task);
    renderDraftTaskSubtasks();
    editingTask = task;
    $('#dialog-title').textContent = task ? t('editTaskTitle') : t('newTaskTitle');
    $('#task-title').value = task?.title ?? '';
    $('#task-details').value = task?.details ?? '';
    $('#task-priority').value = task?.priority ?? 'none';
    $('#task-tags').value = (task?.tags ?? []).join(', ');
    taskForm.querySelector('button[type="submit"]').textContent = t(task ? 'change' : 'createTask');
    updatePhaseOptions(task?.phase ?? phaseName ?? phases[0].name);
    $('#task-save-status').hidden = true;
    $('#task-save-status').textContent = '';
    const filePreview = $('#file-preview');
    filePreview.hidden = !task;
    if (task) filePreview.textContent = t('fileLabel', { folder: task.folderName, file: task.markdownName });
    setTaskDialogMode(mode);
    taskDialog.showModal();
    if (mode === 'edit') $('#task-title').focus();
  }

  function returnToTaskDetails() {
    if (!editingTask) {
      taskDialog.close();
      return;
    }
    pendingFiles = new Map();
    $('#attachment-picker').value = '';
    $('#task-title').value = editingTask.title;
    $('#task-details').value = editingTask.details;
    $('#task-priority').value = editingTask.priority;
    $('#task-tags').value = (editingTask.tags ?? []).join(', ');
    updatePhaseOptions(editingTask.phase);
    $('#task-save-status').hidden = true;
    $('#task-save-status').textContent = '';
    const filePreview = $('#file-preview');
    filePreview.textContent = t('fileLabel', { folder: editingTask.folderName, file: editingTask.markdownName });
    filePreview.hidden = false;
    setTaskDialogMode('view');
  }

  function closeTaskDialog() {
    if (editingTask && $('#task-view').hidden) {
      returnToTaskDetails();
      return;
    }
    taskDialog.close();
  }

  async function getUniqueTaskFolderName(phase, title, excludeName = null) {
    const names = new Set();
    for await (const [name, handle] of phase.handle.entries()) {
      if (handle.kind === 'directory' && name !== excludeName) names.add(name.toLocaleLowerCase());
    }
    return uniqueFolderName(title, names);
  }

  async function writeMarkdown(taskHandle, title, details, fileName = 'task.md') {
    const fileHandle = await taskHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const body = `# ${title.trim()}\n${details.trim() ? `\n${details.trim()}\n` : '\n'}`;
    await writable.write(body);
    await writable.close();
  }

  function imageExtension(file) {
    const extensions = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
      'image/avif': 'avif',
    };
    return extensions[file.type.toLowerCase()] ?? null;
  }

  function createDataFilename(file) {
    const cleanedName = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 100);
    const uniquePart = window.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);
    return `${Date.now()}-${uniquePart}-${cleanedName || 'Anhang'}`;
  }

  function insertAttachmentMarkdown(file, filename, isImage) {
    const textarea = $('#task-details');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const linkPath = `${dataDirectoryName}/${encodeURIComponent(filename)}`;
    const markdown = isImage ? `![${file.name}](${linkPath})` : `[${file.name}](${linkPath})`;
    const insert = `${before && !before.endsWith('\n') ? '\n' : ''}${markdown}${after && !after.startsWith('\n') ? '\n' : ''}`;
    textarea.setRangeText(insert, start, end, 'end');
  }

  function queueAttachments(files, clipboard = false) {
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      if (clipboard && (!isImage || !imageExtension(file))) continue;
      const filename = createDataFilename(file);
      pendingFiles.set(filename, file);
      insertAttachmentMarkdown(file, filename, isImage);
    }
    if (pendingFiles.size) {
      showToast(t(clipboard ? 'imageQueued' : 'attachmentsQueued'));
    }
  }

  async function pasteImages(event) {
    const items = [...(event.clipboardData?.items ?? [])];
    const images = items.map((item) => item.kind === 'file' && item.type.startsWith('image/') ? item.getAsFile() : null).filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    queueAttachments(images, true);
  }

  async function writePendingAttachments(taskHandle) {
    if (!pendingFiles.size) return;
    const dataDirectory = await taskHandle.getDirectoryHandle(dataDirectoryName, { create: true });
    for (const [filename, file] of pendingFiles) {
      const fileHandle = await dataDirectory.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(file);
      await writable.close();
    }
  }

  async function removeUnusedTaskAttachments(taskHandle) {
    let dataDirectory;
    try { dataDirectory = await taskHandle.getDirectoryHandle(dataDirectoryName); }
    catch (error) {
      if (error.name === 'NotFoundError') return;
      throw error;
    }

    const referenced = new Set();
    for await (const [name, handle] of taskHandle.entries()) {
      if (handle.kind !== 'file' || !name.toLowerCase().endsWith('.md')) continue;
      const references = markdownDataReferences(await (await handle.getFile()).text());
      references.forEach((filename) => referenced.add(filename));
    }
    for await (const [name, handle] of dataDirectory.entries()) {
      if (handle.kind !== 'file' || referenced.has(name)) continue;
      await dataDirectory.removeEntry(name);
    }

    let hasEntries = false;
    for await (const _entry of dataDirectory.entries()) {
      hasEntries = true;
      break;
    }
    if (!hasEntries) await taskHandle.removeEntry(dataDirectoryName);
  }

  async function saveTask(event) {
    event.preventDefault();
    if (!rootHandle || !taskForm.reportValidity()) return;
    const saveButton = taskForm.querySelector('button[type="submit"]');
    const saveStatus = $('#task-save-status');
    const saveButtonLabel = t(editingTask ? 'change' : 'createTask');
    saveButton.disabled = true;
    saveButton.textContent = t(editingTask ? 'taskChanging' : 'taskSaving');
    saveStatus.hidden = true;
    saveStatus.textContent = '';
    const title = $('#task-title').value.trim();
    const details = $('#task-details').value;
    const priority = $('#task-priority').value;
    const tags = normalizeTaskTags($('#task-tags').value);
    const phaseName = $('#task-phase').value;
    const isEditingTask = Boolean(editingTask);
    const targetPhase = phases.find((phase) => phase.name === phaseName);
    if (!targetPhase) {
      saveButton.disabled = false;
      saveButton.textContent = saveButtonLabel;
      return;
    }
    const subtasksToSave = editingTask ? [] : draftSubtasks.map((subtask) => ({ ...subtask }));
    draftSubtasksSaving = !editingTask;
    if (!editingTask) renderDraftTaskSubtasks();
    let savedFolderName = null;

    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      if (editingTask) {
        let taskHandle = editingTask.handle;
        let folderName = editingTask.folderName;
        let destinationPhase = targetPhase;
        if (editingTask.phase !== phaseName) {
          folderName = await getUniqueTaskFolderName(targetPhase, title);
          taskHandle = await copyDirectory(editingTask.handle, await targetPhase.handle.getDirectoryHandle(folderName, { create: true }));
          await phases.find((phase) => phase.name === editingTask.phase).handle.removeEntry(editingTask.folderName, { recursive: true });
        } else {
          folderName = await getUniqueTaskFolderName(targetPhase, title, editingTask.folderName);
          if (folderName !== editingTask.folderName) {
            const newHandle = await targetPhase.handle.getDirectoryHandle(folderName, { create: true });
            taskHandle = await copyDirectory(editingTask.handle, newHandle);
            await targetPhase.handle.removeEntry(editingTask.folderName, { recursive: true });
          }
        }
        savedFolderName = folderName;
        await writePendingAttachments(taskHandle);
        await writeTaskCreatedAt(taskHandle, Number.isFinite(editingTask.createdAt) ? editingTask.createdAt : Date.now());
        await writeMarkdown(taskHandle, title, details, editingTask.markdownName || 'task.md');
        await writeTaskPriority(taskHandle, priority);
        await writeTaskTags(taskHandle, tags);
        await removeUnusedTaskAttachments(taskHandle);
        if (editingTask.phase === phaseName) {
          const order = [...(taskOrderByPhase.get(phaseName) ?? [])];
          const taskIndex = order.indexOf(editingTask.folderName);
          if (taskIndex >= 0) order[taskIndex] = folderName;
          else order.push(folderName);
          taskOrderByPhase.set(phaseName, order);
        } else {
          taskOrderByPhase.set(editingTask.phase, (taskOrderByPhase.get(editingTask.phase) ?? [])
            .filter((name) => name !== editingTask.folderName));
          taskOrderByPhase.set(phaseName, [
            ...(taskOrderByPhase.get(phaseName) ?? []).filter((name) => name !== folderName),
            folderName,
          ]);
        }
        try { await savePhaseOrder(phases.map((phase) => phase.name)); }
        catch (orderError) { console.warn('Arbeitspaket wurde gespeichert, aber seine Reihenfolge konnte nicht aktualisiert werden.', orderError); }
        showToast(t('taskSaved', { title }));
      } else {
        const folderName = await getUniqueTaskFolderName(targetPhase, title);
        const taskHandle = await targetPhase.handle.getDirectoryHandle(folderName, { create: true });
        await writePendingAttachments(taskHandle);
        await writeMarkdown(taskHandle, title, details);
        await writeTaskCreatedAt(taskHandle);
        await writeTaskPriority(taskHandle, priority);
        await writeTaskTags(taskHandle, tags);
        if (subtasksToSave.length) await writeSubtasks(taskHandle, subtasksToSave);
        await removeUnusedTaskAttachments(taskHandle);
        showToast(t('taskCreated', { title }));
      }
      if (isEditingTask) {
        pendingFiles = new Map();
        $('#attachment-picker').value = '';
        await loadWorkspace();
        const savedTask = tasks.find((task) => task.phase === phaseName && task.folderName === savedFolderName);
        if (savedTask) {
          editingTask = savedTask;
          $('#task-title').value = savedTask.title;
          $('#task-details').value = savedTask.details;
          $('#task-priority').value = savedTask.priority;
          $('#task-tags').value = savedTask.tags.join(', ');
          updatePhaseOptions(savedTask.phase);
          $('#file-preview').textContent = t('fileLabel', { folder: savedTask.folderName, file: savedTask.markdownName });
          $('#file-preview').hidden = false;
          setTaskDialogMode('view');
        } else {
          taskDialog.close();
        }
      } else {
        taskDialog.close();
        await loadWorkspace();
      }
    } catch (error) {
      saveStatus.textContent = t('taskSaveError', { error: error.message });
      saveStatus.hidden = false;
      showToast(t('taskSaveError', { error: error.message }));
    } finally {
      draftSubtasksSaving = false;
      renderDraftTaskSubtasks();
      saveButton.disabled = false;
      saveButton.textContent = saveButtonLabel;
    }
  }

  async function saveTaskView() {
    if (!editingTask) return;
    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      await writeMarkdown(editingTask.handle, editingTask.title, editingTask.details, editingTask.markdownName || 'task.md');
      await writeTaskPriority(editingTask.handle, editingTask.priority);
      await writeTaskTags(editingTask.handle, editingTask.tags ?? []);
      showToast(t('taskSaved', { title: editingTask.title }));
      taskDialog.close();
      await loadWorkspace();
    } catch (error) {
      showToast(t('taskSaveError', { error: error.message }));
    }
  }

  async function copyDirectory(source, destination) {
    for await (const [name, handle] of source.entries()) {
      if (handle.kind === 'file') {
        const file = await handle.getFile();
        const targetFile = await destination.getFileHandle(name, { create: true });
        const writable = await targetFile.createWritable();
        await writable.write(file);
        await writable.close();
      } else {
        const child = await destination.getDirectoryHandle(name, { create: true });
        await copyDirectory(handle, child);
      }
    }
    return destination;
  }

  async function collectTrashEntries(directoryHandle, path = []) {
    const entries = [];
    for await (const [name, handle] of directoryHandle.entries()) {
      const normalizedName = name.toLocaleLowerCase();
      if (handle.kind === 'file' && name.startsWith('.')) continue;
      if (normalizedName === '.ds_store' || normalizedName === '.created-at' || normalizedName === '.create-at.md') continue;
      const hiddenContainer = handle.kind === 'directory' && (path.length === 0 || name === dataDirectoryName);
      const entryPath = [...path, name];
      if (!hiddenContainer) entries.push({ name, path: entryPath, kind: handle.kind });
      if (handle.kind === 'directory') entries.push(...await collectTrashEntries(handle, entryPath));
    }
    return entries;
  }

  async function hasTrashItems(trash) {
    for await (const _entry of trash.entries()) return true;
    return false;
  }

  async function getTrashLocations() {
    const locations = [];
    if (rootHandle) {
      locations.push({
        directory: await rootHandle.getDirectoryHandle(trashDirectoryName, { create: true }),
        prefix: [],
      });
    }
    if (projectHandle && projectHandle !== rootHandle) {
      locations.push({
        directory: await projectHandle.getDirectoryHandle(trashDirectoryName, { create: true }),
        prefix: [t('boardTrashLabel')],
      });
    }
    return locations;
  }

  async function updateTrashButton() {
    const button = $('#empty-trash-button');
    if (!projectHandle) {
      button.disabled = true;
      button.textContent = t('trashZero');
      button.title = t('trashNoProject');
      return;
    }
    try {
      const locations = await getTrashLocations();
      const entries = [];
      let hasItems = false;
      for (const location of locations) {
        const locationEntries = await collectTrashEntries(location.directory);
        entries.push(...locationEntries.map((entry) => ({
          ...entry,
          path: [...location.prefix, ...entry.path],
        })));
        if (await hasTrashItems(location.directory)) hasItems = true;
      }
      button.disabled = !hasItems;
      button.textContent = t('trashEmpty', { count: entries.length });
      button.title = entries.length
        ? t('trashTooltipCount', { count: entries.length })
        : hasItems ? t('trashTooltipHidden') : t('trashTooltipEmpty');
    } catch (error) {
      button.disabled = true;
      button.textContent = t('trashZero');
      showToast(t('trashReadError', { error: error.message }));
    }
  }

  async function emptyTrash() {
    if (!projectHandle) return;
    try {
      const locations = await getTrashLocations();
      const entries = [];
      const topLevelEntries = [];
      for (const location of locations) {
        const locationEntries = await collectTrashEntries(location.directory);
        entries.push(...locationEntries.map((entry) => ({
          ...entry,
          path: [...location.prefix, ...entry.path],
        })));
        for await (const [name, handle] of location.directory.entries()) {
          topLevelEntries.push({ directory: location.directory, name, kind: handle.kind });
        }
      }
      if (!topLevelEntries.length) {
        await updateTrashButton();
        return;
      }
      const listing = entries.length
        ? entries.map((entry) => `${entry.kind === 'directory' ? '📁' : '📄'} ${entry.path.join('/')}`).join('\n')
        : t('trashHiddenOnly');
      if (!window.confirm(t('emptyTrashConfirm', { listing, count: entries.length }))) return;
      for (const entry of topLevelEntries) {
        await entry.directory.removeEntry(entry.name, { recursive: entry.kind === 'directory' });
      }
      await updateTrashButton();
      showToast(t('trashEmptied'));
    } catch (error) {
      showToast(t('trashEmptyError', { error: error.message }));
      await updateTrashButton();
    }
  }

  async function moveTask(task, targetPhaseName) {
    const targetPhase = phases.find((phase) => phase.name === targetPhaseName);
    const sourcePhase = phases.find((phase) => phase.name === task.phase);
    if (!targetPhase || !sourcePhase) return;
    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      const folderName = await getUniqueTaskFolderName(targetPhase, task.folderName);
      const destination = await targetPhase.handle.getDirectoryHandle(folderName, { create: true });
      await copyDirectory(task.handle, destination);
      await sourcePhase.handle.removeEntry(task.folderName, { recursive: true });
      taskOrderByPhase.set(task.phase, (taskOrderByPhase.get(task.phase) ?? [])
        .filter((name) => name !== task.folderName));
      taskOrderByPhase.set(targetPhaseName, [
        ...(taskOrderByPhase.get(targetPhaseName) ?? []).filter((name) => name !== folderName),
        folderName,
      ]);
      try { await savePhaseOrder(phases.map((phase) => phase.name)); }
      catch (orderError) { console.warn('Arbeitspaket wurde verschoben, aber seine Reihenfolge konnte nicht aktualisiert werden.', orderError); }
      await loadWorkspace();
      showToast(t('taskMoved', { title: task.title, phase: phaseDisplayName(targetPhaseName) }));
    } catch (error) {
      showToast(t('moveError', { error: error.message }));
    }
  }

  function createPhase() {
    if (!rootHandle) return;
    $('#phase-name').value = '';
    $('#phase-color').value = '#8b80f4';
    $('#phase-dialog').showModal();
    $('#phase-name').focus();
  }

  async function saveNewPhase(event) {
    event.preventDefault();
    if (!rootHandle || !await ensurePermission(rootHandle, true)) return;
    const name = $('#phase-name').value;
    if (!name?.trim()) return;
    try {
      const folderName = safeName(name);
      if (folderName.startsWith('.')) {
        showToast(t('invalidPhaseName'));
        return;
      }
      if (phases.some((phase) => phase.name.toLocaleLowerCase() === folderName.toLocaleLowerCase())) {
        showToast(t('phaseExists', { phase: folderName }));
        return;
      }
      await rootHandle.getDirectoryHandle(folderName, { create: true });
      phaseColors.set(folderName, $('#phase-color').value);
      try { await savePhaseOrder([...phases.map((phase) => phase.name), folderName]); }
      catch (orderError) { console.warn('Phase wurde angelegt, aber die Reihenfolge konnte nicht gespeichert werden.', orderError); }
      $('#phase-dialog').close();
      await loadWorkspace();
      showToast(t('phaseCreated', { phase: folderName }));
    } catch (error) { showToast(t('phaseCreateError', { error: error.message })); }
  }

  async function renamePhase(phaseName) {
    const phase = phases.find((item) => item.name === phaseName);
    if (!phase || !rootHandle || !await ensurePermission(rootHandle, true)) return;
    const input = window.prompt(t('phaseRenamePrompt'), phaseDisplayName(phaseName));
    if (!input?.trim()) return;
    const newName = safeName(input);
    if (newName.startsWith('.')) {
      showToast(t('invalidPhaseName'));
      return;
    }
    if (newName === phaseName) return;
    if (phases.some((item) => item.name !== phaseName && item.name.toLocaleLowerCase() === newName.toLocaleLowerCase())) {
      showToast(t('phaseExists', { phase: newName }));
      return;
    }
    let destinationCreated = false;
    let sourceRemoved = false;
    try {
      const destination = await rootHandle.getDirectoryHandle(newName, { create: true });
      destinationCreated = true;
      await copyDirectory(phase.handle, destination);
      await rootHandle.removeEntry(phaseName, { recursive: true });
      sourceRemoved = true;
      if (phaseColors.has(phaseName)) {
        phaseColors.set(newName, phaseColors.get(phaseName));
        phaseColors.delete(phaseName);
      }
      if (taskOrderByPhase.has(phaseName)) {
        taskOrderByPhase.set(newName, taskOrderByPhase.get(phaseName));
        taskOrderByPhase.delete(phaseName);
      }
      try {
        await savePhaseOrder(phases.map((item) => item.name === phaseName ? newName : item.name));
      } catch (orderError) {
        console.warn('Phase wurde umbenannt, aber die gespeicherte Reihenfolge konnte nicht aktualisiert werden.', orderError);
      }
      await loadWorkspace();
      showToast(t('phaseRenamed', { phase: phaseDisplayName(newName) }));
    } catch (error) {
      if (destinationCreated && !sourceRemoved) {
        try { await rootHandle.removeEntry(newName, { recursive: true }); }
        catch (cleanupError) { console.warn('Unvollständiger Zielordner konnte nicht entfernt werden.', cleanupError); }
      }
      showToast(t('phaseRenameError', { error: error.message }));
    }
  }

  async function deletePhase(phaseName) {
    const phase = phases.find((item) => item.name === phaseName);
    if (!phase) return;
    if (phases.length <= 1) {
      showToast(t('minimumPhase'));
      return;
    }
    const taskCount = tasks.filter((task) => task.phase === phaseName).length;
    const contents = taskCount ? t(taskCount === 1 ? 'phaseDeleteWithOneTask' : 'phaseDeleteWithManyTasks', { count: taskCount }) : '';
    if (!window.confirm(t('phaseDeleteConfirm', { phase: phaseDisplayName(phaseName), contents }))) return;

    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      await rootHandle.removeEntry(phaseName, { recursive: true });
      phaseColors.delete(phaseName);
      taskOrderByPhase.delete(phaseName);
      try { await savePhaseOrder(phases.filter((item) => item.name !== phaseName).map((item) => item.name)); }
      catch (orderError) { console.warn('Phase wurde gelöscht, aber die gespeicherte Reihenfolge konnte nicht aktualisiert werden.', orderError); }
      await loadWorkspace();
      showToast(t('phaseDeleted', { phase: phaseDisplayName(phaseName) }));
    } catch (error) { showToast(t('phaseDeleteError', { error: error.message })); }
  }

  async function deleteTask() {
    if (!editingTask || !window.confirm(t('taskDeleteConfirm', { title: editingTask.title }))) return;
    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      const trash = await rootHandle.getDirectoryHandle(trashDirectoryName, { create: true });
      await moveTaskToTrash(editingTask, trash);
      taskOrderByPhase.set(editingTask.phase, (taskOrderByPhase.get(editingTask.phase) ?? [])
        .filter((name) => name !== editingTask.folderName));
      try { await savePhaseOrder(phases.map((item) => item.name)); }
      catch (orderError) { console.warn('Arbeitspaket wurde in den Papierkorb verschoben, aber seine Reihenfolge konnte nicht aktualisiert werden.', orderError); }
      taskDialog.close();
      await loadWorkspace();
      showToast(t('taskDeleted'));
    } catch (error) { showToast(t('taskDeleteError', { error: error.message })); }
  }

  async function moveTaskToTrash(task, trash) {
    const phase = phases.find((item) => item.name === task.phase);
    if (!phase) throw new Error(t('phaseNotFound', { phase: phaseDisplayName(task.phase) }));
    const existingTrashNames = new Set();
    for await (const [name] of trash.entries()) existingTrashNames.add(name.toLocaleLowerCase());
    let trashName = task.folderName;
    let suffix = 2;
    while (existingTrashNames.has(trashName.toLocaleLowerCase())) trashName = `${task.folderName} (${suffix++})`;
    const destination = await trash.getDirectoryHandle(trashName, { create: true });
    try {
      await copyDirectory(task.handle, destination);
      await phase.handle.removeEntry(task.folderName, { recursive: true });
    } catch (error) {
      try { await trash.removeEntry(trashName, { recursive: true }); }
      catch (cleanupError) { console.warn('Unvollständige Papierkorbkopie konnte nicht bereinigt werden.', cleanupError); }
      throw error;
    }
  }

  async function movePhaseTasksToTrash(phaseName) {
    const phaseTasks = tasks.filter((task) => task.phase === phaseName);
    if (!phaseTasks.length) return;
    const listing = phaseTasks.map((task) => `• ${task.title}`).join('\n');
    const confirmKey = phaseTasks.length === 1 ? 'phaseTrashAllConfirmOne' : 'phaseTrashAllConfirmMany';
    if (!window.confirm(t(confirmKey, {
      phase: phaseDisplayName(phaseName),
      count: phaseTasks.length,
      listing,
    }))) return;

    try {
      if (!await ensurePermission(rootHandle, true)) throw new Error(t('writePermissionDenied'));
      const trash = await rootHandle.getDirectoryHandle(trashDirectoryName, { create: true });
      const movedFolders = [];
      const failures = [];
      let orderSaveError = '';
      for (const task of phaseTasks) {
        try {
          await moveTaskToTrash(task, trash);
          movedFolders.push(task.folderName);
        } catch (error) {
          failures.push(`${task.title}: ${error.message}`);
        }
      }

      if (movedFolders.length) {
        taskOrderByPhase.set(phaseName, (taskOrderByPhase.get(phaseName) ?? [])
          .filter((name) => !movedFolders.includes(name)));
        try { await savePhaseOrder(phases.map((phase) => phase.name)); }
        catch (error) { orderSaveError = t('phaseTrashOrderSaveError', { error: error.message }); }
      }
      await loadWorkspace();
      if (failures.length || orderSaveError) {
        showToast(t('phaseTrashPartialError', {
          moved: movedFolders.length,
          failed: failures.length,
          errors: [failures.join('\n'), orderSaveError].filter(Boolean).join('\n'),
        }));
      } else {
        showToast(t(movedFolders.length === 1 ? 'phaseTrashAllDoneOne' : 'phaseTrashAllDoneMany', { count: movedFolders.length }));
      }
    } catch (error) {
      showToast(t('phaseTrashAllError', { error: error.message }));
    }
  }

  $('#open-folder').addEventListener('click', openWorkspace);
  themeToggle.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  $('#welcome-open').addEventListener('click', openWorkspace);
  $('#restore-folder').addEventListener('click', reconnectLastWorkspace);
  $('#add-board-button').addEventListener('click', openWorkspaceBoardDialog);
  $('#board-form').addEventListener('submit', createWorkspaceBoard);
  $('#close-board-dialog').addEventListener('click', () => $('#board-dialog').close());
  $('#cancel-board-dialog').addEventListener('click', () => $('#board-dialog').close());
  $('#delete-board-button').addEventListener('click', () => {
    if (activeBoardFolder) void moveWorkspaceBoardToTrash(activeBoardFolder);
  });
  $('#new-task-button').addEventListener('click', () => openTaskDialog());
  $('#new-phase-button').addEventListener('click', createPhase);
  $('#phase-form').addEventListener('submit', saveNewPhase);
  $('#close-phase-dialog').addEventListener('click', () => $('#phase-dialog').close());
  $('#cancel-phase-dialog').addEventListener('click', () => $('#phase-dialog').close());
  $('#search-input').addEventListener('input', renderBoard);
  $('#overview-phase-filter').addEventListener('change', renderBoard);
  $('#overview-priority-filter').addEventListener('change', renderBoard);
  $('#overview-tag-filter').addEventListener('change', renderBoard);
  $('#task-form').addEventListener('submit', saveTask);
  $('#add-comment').addEventListener('click', addTaskComment);
  $('#add-subtask').addEventListener('click', addTaskSubtask);
  $('#toggle-completed-subtasks').addEventListener('click', () => {
    hideCompletedSubtasks = !hideCompletedSubtasks;
    if (editingTask) renderTaskSubtasks(editingTask);
  });
  $('#add-draft-subtask').addEventListener('click', addDraftTaskSubtask);
  $('#new-subtask').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void addTaskSubtask();
    }
  });
  $('#new-draft-subtask').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addDraftTaskSubtask();
    }
  });
  $('#task-details').addEventListener('paste', pasteImages);
  $('#attachment-picker').addEventListener('change', (event) => {
    queueAttachments([...event.target.files]);
    event.target.value = '';
  });
  $('#delete-task-view').addEventListener('click', deleteTask);
  $('#save-task-view').addEventListener('click', saveTaskView);
  $('#empty-trash-button').addEventListener('click', emptyTrash);
  $('#edit-task').addEventListener('click', () => setTaskDialogMode('edit'));
  $('#close-dialog').addEventListener('click', closeTaskDialog);
  taskDialog.addEventListener('close', () => {
    releaseRenderedImages();
    pendingFiles = new Map();
    draftSubtasks = [];
    draftSubtasksSaving = false;
    renderDraftTaskSubtasks();
  });
  $('#help-button').addEventListener('click', () => infoDialog.showModal());
  $('#close-info').addEventListener('click', () => infoDialog.close());
  $('#info-done').addEventListener('click', () => infoDialog.close());
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#search-input').focus();
    }
  });
  void restoreLastWorkspace();
})();
