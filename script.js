(function(){
  const DB_URL = './openleaf-dictionary.db';
  const POS = {1:'noun',2:'verb',3:'adjective',4:'adverb',5:'pronoun',6:'preposition',7:'conjunction',8:'interjection',9:'phrase'};

  const searchEl = document.getElementById('search');
  const suggestEl = document.getElementById('suggestions');
  const statusEl = document.getElementById('status');
  const progressEl = document.getElementById('progress');
  const resultEl = document.getElementById('result');

  let db = null, presetDict = null, lookupStmt = null, prefixStmt = null;
  let activeIndex = -1;

  function setStatus(msg){ statusEl.firstChild.textContent = msg; }

  async function loadDatabase(){
    const resp = await fetch(DB_URL);
    if (!resp.ok) throw new Error('Could not fetch ' + DB_URL + ' (HTTP ' + resp.status + ')');
    const total = +resp.headers.get('Content-Length') || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true){
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total) progressEl.style.width = Math.round(loaded / total * 100) + '%';
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks){ bytes.set(chunk, offset); offset += chunk.length; }

    const SQL = await initSqlJs({ locateFile: f => 'https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/' + f });
    db = new SQL.Database(bytes);

    const metaRes = db.exec("SELECT value FROM meta WHERE key = 'preset_dict'");
    presetDict = metaRes[0].values[0][0];

    lookupStmt = db.prepare("SELECT word, ipa, points_to, meanings FROM words WHERE word = ? COLLATE NOCASE LIMIT 1");
    prefixStmt = db.prepare("SELECT word FROM words WHERE word >= ? AND word < ? ORDER BY word LIMIT 8");
  }

  function decodeMeanings(blob){
    const inflated = pako.inflateRaw(new Uint8Array(blob), { dictionary: presetDict });
    const text = new TextDecoder('utf-8').decode(inflated);
    return JSON.parse(text);
  }

  function fetchWord(word){
    lookupStmt.bind([word]);
    const row = lookupStmt.step() ? lookupStmt.getAsObject() : null;
    lookupStmt.reset();
    return row;
  }

  function fetchPrefix(prefix){
    prefixStmt.bind([prefix, prefix + '\uffff']);
    const words = [];
    while (prefixStmt.step()) words.push(prefixStmt.getAsObject().word);
    prefixStmt.reset();
    return words;
  }

  function renderSenses(senses){
    if (!senses.length) return '<p class="empty">No senses recorded for this word.</p>';
    return '<ol class="senses">' + senses.map(([posId, def, example, synonyms]) => `
      <li>
        <span class="pos">${POS[posId] || 'unknown'}</span>
        <p class="definition">${escapeHtml(def)}</p>
        ${example ? `<p class="example">“${escapeHtml(example)}”</p>` : ''}
        ${synonyms && synonyms.length ? `<p class="synonyms"><b>Similar:</b> ${synonyms.map(s => `<span class="syn-chip">${escapeHtml(s)}</span>`).join('')}</p>` : ''}
      </li>`).join('') + '</ol>';
  }

  function escapeHtml(str){
    return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function showEntry(searchedWord){
    let row = fetchWord(searchedWord);
    if (!row){
      resultEl.innerHTML = `<p class="not-found">No entry for “${escapeHtml(searchedWord)}”.</p>`;
      return;
    }

    let redirectFrom = null;
    let senses = decodeMeanings(row.meanings);
    let hops = 0;
    while (senses.length === 0 && row.points_to && hops < 5){
      redirectFrom = row.word;
      const next = fetchWord(row.points_to);
      if (!next) break;
      row = next;
      senses = decodeMeanings(row.meanings);
      hops++;
    }

    const seeAlso = (!redirectFrom && row.points_to) ? row.points_to : null;

    resultEl.innerHTML = `
      <div class="headword-row">
        <h2 class="headword">${escapeHtml(row.word)}</h2>
        ${row.ipa ? `<span class="ipa">${escapeHtml(row.ipa)}</span>` : ''}
      </div>
      ${redirectFrom ? `<p class="redirect-note">“${escapeHtml(redirectFrom)}” is a form of <b>${escapeHtml(row.word)}</b>.</p>` : ''}
      ${seeAlso ? `<p class="redirect-note">See also: <b class="see-also-link">${escapeHtml(seeAlso)}</b></p>` : ''}
      ${renderSenses(senses)}
    `;

    const seeAlsoEl = resultEl.querySelector('.see-also-link');
    if (seeAlsoEl){
      seeAlsoEl.style.cursor = 'pointer';
      seeAlsoEl.style.textDecoration = 'underline';
      seeAlsoEl.addEventListener('click', () => {
        searchEl.value = seeAlso;
        showEntry(seeAlso);
      });
    }
  }

  function updateSuggestions(){
    const q = searchEl.value.trim();
    activeIndex = -1;
    if (!q){ suggestEl.style.display = 'none'; return; }
    const words = fetchPrefix(q);
    if (!words.length){ suggestEl.style.display = 'none'; return; }
    suggestEl.innerHTML = words.map(w => `<button type="button">${escapeHtml(w)}</button>`).join('');
    suggestEl.style.display = 'block';
    [...suggestEl.children].forEach(btn => {
      btn.addEventListener('click', () => {
        searchEl.value = btn.textContent;
        suggestEl.style.display = 'none';
        showEntry(btn.textContent);
      });
    });
  }

  searchEl.addEventListener('input', () => {
    clearTimeout(searchEl._t);
    searchEl._t = setTimeout(updateSuggestions, 120);
  });

  searchEl.addEventListener('keydown', (e) => {
    const items = [...suggestEl.children];
    if (e.key === 'ArrowDown' && items.length){
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    } else if (e.key === 'ArrowUp' && items.length){
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    } else if (e.key === 'Enter'){
      suggestEl.style.display = 'none';
      const chosen = activeIndex >= 0 && items[activeIndex] ? items[activeIndex].textContent : searchEl.value.trim();
      if (chosen) showEntry(chosen);
    } else if (e.key === 'Escape'){
      suggestEl.style.display = 'none';
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-card')) suggestEl.style.display = 'none';
  });

  loadDatabase().then(() => {
    statusEl.style.display = 'none';
    searchEl.disabled = false;
    searchEl.focus();
  }).catch(err => {
    setStatus('Could not load the dictionary.');
    resultEl.innerHTML = `<p class="not-found">${escapeHtml(err.message)}.</p>`;
  });
})();
