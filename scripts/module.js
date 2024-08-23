const MODULE_NAME = 'rolltable-requester';
const TEMPLATE_PATH = `/modules/${MODULE_NAME}/templates`;
const WHISPER_FN = 'cheekyWhisper';

const RT_CLASS = 'RollTable';
const MAX_DEPTH = 10;

let socket;

async function getDocIfRollTable(tableResult) {
  if (tableResult.type === CONST.TABLE_RESULT_TYPES.DOCUMENT && tableResult.documentCollection === RT_CLASS) {
    return game.tables.get(tableResult.documentId);
  }
  if (tableResult.type === CONST.TABLE_RESULT_TYPES.COMPENDIUM) {
    const collection = game.packs.get(tableResult.documentCollection);
    if (collection && collection.documentClass.name === RT_CLASS) {
      return await collection.getDocument(tableResult.documentId);
    }
  }
}

// Recusion FTW
async function getResultsFromTable(table, depth = 0, seen = {}) {
  const opts = { permanent: true, console: true };
  if (table.id in seen) {
    ui.notifications.warn('You have a circular reference of tables referencing themselves.', opts);
    return [];
  }
  if (depth >= MAX_DEPTH) {
    ui.notifications.warn('Too many nested roll tables. I think it is time to stop...', opts);
    return [];
  }
  seen[table.id] = true;
  const formula = table.formula ?? table.data.formula;
  const pRoll = new Roll(formula);
  const die = await pRoll.roll({ async: true });
  await pRoll.toMessage({}, {
    rollMode: CONFIG.Dice.rollModes.publicroll,
    create: true,
  });
  const results = table.getResultsForRoll(die.total);
  console.log(`[RTR] Rolled a ${die.total} on ${table.name} (depth ${depth})`);
  if (!results) { return []; }
  return (await Promise.all(results.map(async result => {
    if (result.type === CONST.TABLE_RESULT_TYPES.TEXT) {
      return result;
    }
    const nextTable = await getDocIfRollTable(result);
    if (nextTable) {
      return getResultsFromTable(nextTable, depth + 1, {...seen});
    }
    return result;
  }))).flat();
}

async function rolltableRequesterMakeRoll(table, { blind } = { blind: true }) {
  const results = await getResultsFromTable(table);
  console.log(`[RTR] Got results:`, results);
  if (!results) { return; }
  const thanks = game.i18n.localize('RolltableRequester.PlayerThanks');
  const user = thanks.replace(/\[PLAYER\]/g, game.user.name);
  const myHtml = await renderTemplate(`${TEMPLATE_PATH}/result-card.html`, {
    name: table.name,
    thumbnail: table.thumbnail,
    user,
    system: game.system.id,
    results: results.map(r => ({
      icon: r.icon,
      content: r.getChatText ? r.getChatText() : r.data.text
    }))
  });
  const drawChatData = {
      user: game.user.id,
      content: myHtml,
      whisper: ChatMessage.getWhisperRecipients('GM'),
      blind,
      flavor: "",
  };

  if (blind) {
    drawChatData.flavor = `${game.user.name} privately rolled some dice`;
    ChatMessage.create(drawChatData, {});
  } else {
    drawChatData.blind = false;
    drawChatData.whisper = [];
    ChatMessage.create(drawChatData, {});
  }
  
}

async function makeRollById(tid, blind) {
  const table = game.tables.get(tid);
  rolltableRequesterMakeRoll(table, { blind });
}

async function makeRollByName(tableName) {
  const table = game.tables.getName(tableName);
  rolltableRequesterMakeRoll(table);
}

async function requestRollById(tid, { blind, description } = { blind: false, description: false }) {
  const tmplData = {
    name: '???',
    thumbnail: 'icons/svg/d20-grey.svg',
    tid,
    blind: true,
    system: game.system.id,
  };
  let table;
  if (!blind || description) { table = game.tables.get(tid); }
  if (!blind) {
    tmplData.name = table.name;
    tmplData.thumbnail = table.thumbnail;
    tmplData.blind = false;
  }
  if (description) {
    tmplData.description = table.description;
    if (typeof tmplData.description === 'string' && tmplData.description.length && !tmplData.description.includes('<')) {
      const paras = tmplData.description.split(/\r?\n\r?\n/).filter(x => !!x.trim()).join('</p><p>');
      tmplData.description = `<p>${paras}</p>`;
    }
  }
  const myHtml = await renderTemplate(`${TEMPLATE_PATH}/request-card.html`, tmplData);
  const chatData = {
    user: game.user.id,
    content: myHtml
  };
  ChatMessage.create(chatData, {});
  return table;
}

async function requestRollByName(tableName, opts = { blind: false, description: false }) {
  const table = game.tables.getName(tableName);
  return await requestRollById(table.id, opts);
}

function cheekyWhisper(msg) {
  const chatMsg = {
    ...msg,
    whisper: ChatMessage.getWhisperRecipients('GM'),
  }
  ChatMessage.create(chatMsg);
}

Hooks.once('init', async function() {
  globalThis.RolltableRequester = {
    requestRollById,
    requestRollByName,
    makeRollById,
    makeRollByName,
  }
});

Hooks.once('socketlib.ready', () => {
  socket = socketlib.registerModule(MODULE_NAME);
  socket.register(WHISPER_FN, cheekyWhisper);
});

Hooks.once('ready', async function() {
  $(document).on('click.rolltable-requester', '.rt-requester', function() {
    console.log(`RR: Handling button click.`);
    const c = $(this);
    const blind = c.data('blind');
    const tid = c.data('tableid');
    
    makeRollById(tid, blind);
  });
});

Hooks.on('getRollTableDirectoryEntryContext', async function(_, entries) {
  const menuId = 'rolltable-requester';
  if (entries.some(e => e.menuId === menuId)) {
    return;
  }
  // Add entries at the top.
  entries.unshift({
    menuId,
    name: game.i18n.localize('RolltableRequester.MenuGMRoll'),
    icon: '<i class="fas fa-dice-d20"></i>',
    callback: (target) => makeRollById(target.data('document-id')),
  }, {
    name: game.i18n.localize('RolltableRequester.MenuRequestRoll'),
    icon: '<i class="fas fa-question-circle"></i>',
    condition: game.user.isGM,
    callback: (target) => requestRollById(target.data('document-id')),
  }, {
    name: game.i18n.localize('RolltableRequester.MenuRequestDescRoll'),
    icon: '<i class="fas fa-question-circle"></i>',
    condition: game.user.isGM,
    callback: (target) => requestRollById(target.data('document-id'), { description: true }),
  }, {
    name: game.i18n.localize('RolltableRequester.MenuRequestBlindRoll'),
    icon: '<i class="fas fa-eye-slash"></i>',
    condition: game.user.isGM,
    callback: (target) => requestRollById(target.data('document-id'), { blind: true }),
  }, {
    name: game.i18n.localize('RolltableRequester.MenuRequestBlindDescRoll'),
    icon: '<i class="fas fa-eye-slash"></i>',
    condition: game.user.isGM,
    callback: (target) => requestRollById(target.data('document-id'), { blind: true }, { description: true }),
  });
});
