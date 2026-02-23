/* ================================================================
   admin-sprites.js — Sprite Editor Tab
   Pattern library, pixel canvas, palette, image-to-pixel converter
   ================================================================ */

(function () {
    'use strict';
    var A = Admin;
    var PAL = A.PAL, PATTERNS;
    var el = A.el;

    // ── State ──
    var currentPatKey = null;
    var zoom = 16;
    var isDrawing = false;
    var history = [];
    var historyIdx = -1;
    var MAX_HIST = 60;
    var filterText = '';

    // Snapshot of original patterns from game.js (for "Reset to Default")
    var defaultPatterns = {};

    // Image tracer state
    var refImg = null, refImgData = null, refScale = 4;
    var tracedPreview = null; // holds the auto-trace result before applying
    var transparentColors = {}; // hex color → true, colors treated as transparent during trace

    // DOM refs (set during init)
    var libraryList, paletteBar, canvasEl, canvasCtx;
    var refCanvasEl, refCanvasCtx;
    var dimLabel, patNameLabel, statusEl;

    function getPatterns() {
        if (typeof NES !== 'undefined' && NES.PATTERNS) return NES.PATTERNS;
        return A.PATTERNS;
    }

    // ── Pattern categories ──
    function categorize(key) {
        if (/^turtle/i.test(key)) return 'Turtles';
        if (/^wagon/i.test(key)) return 'Wagon';
        if (/^bldg/i.test(key)) return 'Buildings (32×32)';
        if (/^(sewer|street|dock|gallery)(Floor|Wall)/i.test(key)) return 'Level Tiles';
        if (/^(water|canal|coast|mountain|land|road)/i.test(key)) return 'Terrain';
        if (/^(stone|brick|roof|door|window|awning|manhole|sign|neon)/i.test(key)) return 'Architecture';
        if (/^(enemy|hit|hazard|lvl)/i.test(key)) return 'Level Objects';
        return 'Other';
    }

    function groupedKeys() {
        PATTERNS = getPatterns();
        var keys = Object.keys(PATTERNS);
        var groups = {};
        keys.forEach(function (k) {
            if (filterText && k.toLowerCase().indexOf(filterText.toLowerCase()) === -1) return;
            var cat = categorize(k);
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(k);
        });
        return groups;
    }

    // ── Build the UI ──
    function init() {
        PATTERNS = getPatterns();
        // Snapshot all original patterns for "Reset to Default"
        if (Object.keys(defaultPatterns).length === 0) {
            Object.keys(PATTERNS).forEach(function (k) {
                defaultPatterns[k] = PATTERNS[k].map(function (r) { return r; });
            });
        }
        var panel = document.getElementById('tab-sprites');
        panel.innerHTML = '';
        panel.style.cssText = 'gap:0;';

        // Left: pattern library
        var left = el('div', { style: { width: '240px', minWidth: '200px', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--surface)' } });
        var leftHead = el('div', { style: { padding: '8px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '6px' } });
        leftHead.appendChild(el('div', { className: 'panel-title', textContent: 'Pattern Library' }));
        var searchInput = el('input', { type: 'text', placeholder: 'Filter...', style: { width: '100%' } });
        searchInput.addEventListener('input', function () { filterText = this.value; renderLibrary(); });
        leftHead.appendChild(searchInput);
        var actRow = el('div', { className: 'btn-row' });
        actRow.appendChild(el('button', { className: 'btn small success', textContent: '+ New', onClick: createPattern }));
        actRow.appendChild(el('button', { className: 'btn small', textContent: 'Duplicate', onClick: duplicatePattern }));
        actRow.appendChild(el('button', { className: 'btn small danger', textContent: 'Delete', onClick: deletePattern }));
        leftHead.appendChild(actRow);
        left.appendChild(leftHead);
        libraryList = el('div', { style: { flex: '1', overflowY: 'auto', padding: '4px' } });
        left.appendChild(libraryList);

        // Center: canvas + palette
        var center = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' } });

        // Palette bar
        paletteBar = el('div', { style: { padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexWrap: 'wrap', gap: '3px', alignItems: 'center' } });
        center.appendChild(paletteBar);

        // Toolbar
        var toolbar = el('div', { style: { padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } });
        patNameLabel = el('span', { className: 'mono', style: { fontWeight: '600', color: 'var(--accent)' }, textContent: '(none)' });
        dimLabel = el('span', { className: 'mono', style: { color: 'var(--muted)', fontSize: '11px' } });
        toolbar.appendChild(patNameLabel);
        toolbar.appendChild(dimLabel);
        toolbar.appendChild(el('span', { style: { flex: '1' } }));
        toolbar.appendChild(el('label', { textContent: 'Zoom:' }));
        var zoomSel = el('select');
        [1,2,4,8,12,16,20,24,32].forEach(function (z) {
            var opt = el('option', { value: String(z), textContent: z + 'x' });
            if (z === zoom) opt.selected = true;
            zoomSel.appendChild(opt);
        });
        zoomSel.addEventListener('change', function () { zoom = parseInt(this.value); renderCanvas(); });
        toolbar.appendChild(zoomSel);
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Undo', onClick: undo }));
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Redo', onClick: redo }));
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Rename', onClick: renamePattern }));
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Resize', onClick: resizePattern }));
        toolbar.appendChild(el('button', { className: 'btn small danger', textContent: 'Reset Default', onClick: resetToDefault }));
        toolbar.appendChild(el('button', { className: 'btn small success', textContent: 'Export Code', onClick: exportCode }));
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Export All JSON', onClick: function () {
            A.downloadJSON(serializeAllPatterns(), 'patterns_export.json');
        }}));
        center.appendChild(toolbar);

        // Canvas area
        var canvasWrap = el('div', { style: { flex: '1', overflow: 'auto', background: '#0a0b10', display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', padding: '16px' } });
        canvasEl = el('canvas', { style: { cursor: 'crosshair', border: '1px solid var(--border)' } });
        canvasCtx = canvasEl.getContext('2d');
        canvasWrap.appendChild(canvasEl);
        center.appendChild(canvasWrap);

        statusEl = el('div', { className: 'status-msg', style: { padding: '4px 10px', borderTop: '1px solid var(--border)' } });
        center.appendChild(statusEl);

        // Right: image-to-pixel converter
        var right = el('div', { style: { width: '300px', minWidth: '260px', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--surface)', overflowY: 'auto' } });
        var rightHead = el('div', { style: { padding: '8px', borderBottom: '1px solid var(--border)' } });
        rightHead.appendChild(el('div', { className: 'panel-title', textContent: 'Image → Pixel Converter' }));
        right.appendChild(rightHead);

        var rightBody = el('div', { style: { padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' } });

        rightBody.appendChild(el('button', { className: 'btn small primary', textContent: 'Load Reference Image', onClick: loadRefImage }));
        var refInfo = el('div', { id: 'refInfo', style: { fontSize: '11px', color: 'var(--muted)' } });
        rightBody.appendChild(refInfo);

        var refZoomRow = el('div', { className: 'row', style: { flexWrap: 'wrap' } });
        refZoomRow.appendChild(el('label', { textContent: 'Ref Zoom:' }));
        [1,2,4,6,8].forEach(function (s) {
            refZoomRow.appendChild(el('button', { className: 'btn small', textContent: s + 'x', onClick: function () { refScale = s; drawRefImage(); } }));
        });
        rightBody.appendChild(refZoomRow);

        var refCoord = el('div', { id: 'refCoord', style: { fontSize: '11px', color: 'var(--nes-yellow)', minHeight: '16px' } });
        rightBody.appendChild(refCoord);

        refCanvasEl = el('canvas', { style: { maxWidth: '100%', cursor: 'crosshair', border: '1px solid var(--border)', background: '#000' } });
        refCanvasCtx = refCanvasEl.getContext('2d');
        rightBody.appendChild(refCanvasEl);

        // Transparent color picker
        rightBody.appendChild(el('div', {
            style: { fontSize: '10px', color: 'var(--muted)', marginTop: '4px' },
            textContent: 'Shift+click ref image to mark colors as transparent:'
        }));
        var transpRow = el('div', { id: 'transpColorRow', style: {
            display: 'flex', flexWrap: 'wrap', gap: '3px', alignItems: 'center',
            minHeight: '24px', padding: '4px', borderRadius: '4px',
            border: '1px dashed var(--border)', background: 'var(--surface0)'
        }});
        var transpPlaceholder = el('span', { id: 'transpPlaceholder', style: {
            fontSize: '10px', color: 'var(--muted)', fontStyle: 'italic'
        }, textContent: 'No colors selected' });
        transpRow.appendChild(transpPlaceholder);
        rightBody.appendChild(transpRow);
        var transpBtnRow = el('div', { style: { display: 'flex', gap: '4px', marginTop: '2px' } });
        transpBtnRow.appendChild(el('button', { className: 'btn small danger', textContent: 'Clear All', onClick: function () {
            transparentColors = {};
            renderTranspSwatches();
        }}));
        rightBody.appendChild(transpBtnRow);

        rightBody.appendChild(el('hr'));
        rightBody.appendChild(el('div', { className: 'panel-title', textContent: 'Auto-Trace Region' }));
        rightBody.appendChild(el('div', { style: { fontSize: '10px', color: 'var(--muted)', marginBottom: '4px' }, textContent: 'Source crop (pixels in reference image):' }));

        var cropGrid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' } });
        var cropX = el('input', { type: 'number', id: 'cropX', value: '0', min: '0', style: { width: '100%' } });
        var cropY = el('input', { type: 'number', id: 'cropY', value: '0', min: '0', style: { width: '100%' } });
        var cropW = el('input', { type: 'number', id: 'cropW', value: '16', min: '1', style: { width: '100%' } });
        var cropH = el('input', { type: 'number', id: 'cropH', value: '16', min: '1', style: { width: '100%' } });
        [cropX, cropY, cropW, cropH].forEach(function (inp) {
            inp.addEventListener('input', function () { drawRefImage(); });
        });
        cropGrid.appendChild(el('label', {}, ['X: ', cropX]));
        cropGrid.appendChild(el('label', {}, ['Y: ', cropY]));
        cropGrid.appendChild(el('label', {}, ['W: ', cropW]));
        cropGrid.appendChild(el('label', {}, ['H: ', cropH]));
        rightBody.appendChild(cropGrid);
        var cropBtnRow = el('div', { style: { display: 'flex', gap: '4px', marginTop: '2px', marginBottom: '4px' } });
        cropBtnRow.appendChild(el('button', { className: 'btn small', textContent: 'Full Image', onClick: function () {
            if (!refImg) return;
            document.getElementById('cropX').value = 0;
            document.getElementById('cropY').value = 0;
            document.getElementById('cropW').value = refImg.width;
            document.getElementById('cropH').value = refImg.height;
            drawRefImage();
        }}));
        rightBody.appendChild(cropBtnRow);

        rightBody.appendChild(el('div', { style: { fontSize: '10px', color: 'var(--muted)', marginTop: '6px', marginBottom: '4px' }, textContent: 'Output size (pattern dimensions):' }));
        var outGrid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' } });
        var outW = el('input', { type: 'number', id: 'outW', value: '16', min: '1', max: '256', style: { width: '100%' } });
        var outH = el('input', { type: 'number', id: 'outH', value: '16', min: '1', max: '256', style: { width: '100%' } });
        outGrid.appendChild(el('label', {}, ['Out W: ', outW]));
        outGrid.appendChild(el('label', {}, ['Out H: ', outH]));
        rightBody.appendChild(outGrid);
        var outBtnRow = el('div', { style: { display: 'flex', gap: '4px', marginTop: '2px' } });
        outBtnRow.appendChild(el('button', { className: 'btn small', textContent: 'Match Source', onClick: function () {
            document.getElementById('outW').value = document.getElementById('cropW').value;
            document.getElementById('outH').value = document.getElementById('cropH').value;
        }}));
        outBtnRow.appendChild(el('button', { className: 'btn small', textContent: '½×', onClick: function () {
            document.getElementById('outW').value = Math.max(1, Math.round(parseInt(document.getElementById('cropW').value) / 2));
            document.getElementById('outH').value = Math.max(1, Math.round(parseInt(document.getElementById('cropH').value) / 2));
        }}));
        outBtnRow.appendChild(el('button', { className: 'btn small', textContent: '¼×', onClick: function () {
            document.getElementById('outW').value = Math.max(1, Math.round(parseInt(document.getElementById('cropW').value) / 4));
            document.getElementById('outH').value = Math.max(1, Math.round(parseInt(document.getElementById('cropH').value) / 4));
        }}));
        rightBody.appendChild(outBtnRow);

        var traceBtnRow = el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } });
        traceBtnRow.appendChild(el('button', { className: 'btn small primary', textContent: 'Preview Trace', onClick: autoTracePreview }));
        var applyBtn = el('button', { id: 'applyTraceBtn', className: 'btn small success', textContent: 'Apply to Sprite', onClick: applyTrace, disabled: true });
        applyBtn.style.opacity = '0.4';
        traceBtnRow.appendChild(applyBtn);
        rightBody.appendChild(traceBtnRow);

        // Preview canvas for traced result
        var previewLabel = el('div', { id: 'tracePreviewLabel', style: { fontSize: '10px', color: 'var(--muted)', marginTop: '6px', display: 'none' }, textContent: 'Trace Preview:' });
        rightBody.appendChild(previewLabel);
        var previewCanvas = el('canvas', { id: 'tracePreviewCanvas', style: { maxWidth: '100%', border: '1px solid var(--border)', background: '#0a0b10', display: 'none', imageRendering: 'pixelated' } });
        rightBody.appendChild(previewCanvas);

        right.appendChild(rightBody);

        panel.appendChild(left);
        panel.appendChild(center);
        panel.appendChild(right);

        // Events
        canvasEl.addEventListener('mousedown', onCanvasDown);
        canvasEl.addEventListener('mousemove', onCanvasMove);
        canvasEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        document.addEventListener('mouseup', function () {
            if (isDrawing) { isDrawing = false; A.scheduleSave(); }
        });
        document.addEventListener('keydown', onKeyDown);

        refCanvasEl.addEventListener('mousemove', onRefMove);
        refCanvasEl.addEventListener('click', onRefClick);

        renderPalette();
        renderLibrary();

        // Auto-select first pattern
        var firstKey = Object.keys(PATTERNS)[0];
        if (firstKey) selectPattern(firstKey);
    }

    // ── Palette ──
    function renderPalette() {
        paletteBar.innerHTML = '';
        A.PAL_KEYS.forEach(function (k) {
            var sw = el('span', { className: 'pal-swatch' + (k === A.activePalKey ? ' active' : ''), title: k + (PAL[k] ? ' = ' + PAL[k] : ' (transparent)') });
            if (PAL[k]) {
                sw.style.background = PAL[k];
            } else {
                sw.style.background = 'repeating-conic-gradient(#333 0% 25%, #1a1a2e 0% 50%) 50% / 8px 8px';
            }
            sw.addEventListener('click', function () {
                A.activePalKey = k;
                paletteBar.querySelectorAll('.pal-swatch').forEach(function (s) { s.classList.remove('active'); });
                sw.classList.add('active');
            });
            paletteBar.appendChild(sw);
        });
    }

    // ── Library ──
    function renderLibrary() {
        libraryList.innerHTML = '';
        var groups = groupedKeys();
        var cats = Object.keys(groups).sort();
        cats.forEach(function (cat) {
            var header = el('div', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--muted)', padding: '6px 4px 2px', textTransform: 'uppercase' }, textContent: cat });
            libraryList.appendChild(header);
            groups[cat].forEach(function (key) {
                var pat = PATTERNS[key];
                var rows = pat.length, cols = pat[0].length;
                var item = el('div', {
                    className: 'lib-item' + (key === currentPatKey ? ' selected' : ''),
                    style: {
                        display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', cursor: 'pointer',
                        borderRadius: '4px', background: key === currentPatKey ? 'var(--surface2)' : 'transparent',
                        border: key === currentPatKey ? '1px solid var(--accent)' : '1px solid transparent'
                    }
                });
                var thumb = el('canvas', { width: String(cols * 2), height: String(rows * 2), style: { flexShrink: '0' } });
                A.renderPatternToCanvas(thumb, pat, 4);
                item.appendChild(thumb);
                var info = el('div', { style: { overflow: 'hidden' } });
                info.appendChild(el('div', { className: 'mono', style: { fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, textContent: key }));
                info.appendChild(el('div', { style: { fontSize: '10px', color: 'var(--muted)' }, textContent: cols + '×' + rows }));
                item.appendChild(info);
                item.addEventListener('click', function () { selectPattern(key); });
                libraryList.appendChild(item);
            });
        });
    }

    function selectPattern(key) {
        currentPatKey = key;
        history = [];
        historyIdx = -1;
        pushHistory();
        renderLibrary();
        renderCanvas();
        patNameLabel.textContent = key;
        var pat = PATTERNS[key];
        dimLabel.textContent = pat[0].length + '×' + pat.length + ' px';
    }

    // ── Canvas rendering ──
    function renderCanvas() {
        if (!currentPatKey || !PATTERNS[currentPatKey]) return;
        var pat = PATTERNS[currentPatKey];
        var rows = pat.length, cols = pat[0].length;
        var dpr = window.devicePixelRatio || 1;
        var logW = cols * zoom, logH = rows * zoom;
        canvasEl.width = Math.round(logW * dpr);
        canvasEl.height = Math.round(logH * dpr);
        canvasEl.style.width = logW + 'px';
        canvasEl.style.height = logH + 'px';
        var ctx = canvasCtx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                var ch = pat[r][c];
                var color = PAL[ch];
                if (!color) {
                    ctx.fillStyle = ((r + c) % 2 === 0) ? '#1a1a2e' : '#222238';
                } else {
                    ctx.fillStyle = color;
                }
                ctx.fillRect(c * zoom, r * zoom, zoom, zoom);
            }
        }

        if (zoom >= 4) {
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 0.5;
            for (var x = 0; x <= logW; x += zoom) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, logH); ctx.stroke();
            }
            for (var y = 0; y <= logH; y += zoom) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(logW, y); ctx.stroke();
            }
        }
    }

    // ── History ──
    function pushHistory() {
        if (!currentPatKey) return;
        var snap = PATTERNS[currentPatKey].map(function (r) { return r.slice ? r.slice() : r; });
        if (historyIdx < history.length - 1) history = history.slice(0, historyIdx + 1);
        history.push(snap);
        if (history.length > MAX_HIST) history.shift();
        historyIdx = history.length - 1;
    }

    function undo() {
        if (historyIdx <= 0) return;
        historyIdx--;
        PATTERNS[currentPatKey] = history[historyIdx].map(function (r) { return r.slice ? r.slice() : r; });
        renderCanvas();
        renderLibrary();
    }

    function redo() {
        if (historyIdx >= history.length - 1) return;
        historyIdx++;
        PATTERNS[currentPatKey] = history[historyIdx].map(function (r) { return r.slice ? r.slice() : r; });
        renderCanvas();
        renderLibrary();
    }

    // ── Canvas interaction ──
    function pixelAt(e) {
        var rect = canvasEl.getBoundingClientRect();
        var c = Math.floor((e.clientX - rect.left) / zoom);
        var r = Math.floor((e.clientY - rect.top) / zoom);
        return { c: c, r: r };
    }

    function paintPixel(c, r, key) {
        var pat = PATTERNS[currentPatKey];
        if (!pat || r < 0 || r >= pat.length || c < 0 || c >= pat[0].length) return;
        var row = pat[r];
        pat[r] = row.substring(0, c) + key + row.substring(c + 1);
    }

    function onCanvasDown(e) {
        e.preventDefault();
        if (!currentPatKey) return;
        pushHistory();
        isDrawing = true;
        var p = pixelAt(e);
        var key = e.button === 2 ? '.' : A.activePalKey;
        paintPixel(p.c, p.r, key);
        renderCanvas();
    }

    function onCanvasMove(e) {
        if (!isDrawing || !currentPatKey) return;
        var p = pixelAt(e);
        var key = e.buttons === 2 ? '.' : A.activePalKey;
        paintPixel(p.c, p.r, key);
        renderCanvas();
    }

    function onKeyDown(e) {
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
        if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
    }

    // ── Pattern actions ──
    function createPattern() {
        var name = prompt('Pattern name (e.g. myTile):');
        if (!name) return;
        var w = parseInt(prompt('Width (pixels):', '16')) || 16;
        var h = parseInt(prompt('Height (pixels):', '16')) || 16;
        var pat = [];
        for (var r = 0; r < h; r++) pat.push('.'.repeat(w));
        PATTERNS[name] = pat;
        selectPattern(name);
        A.scheduleSave();
        status('Created: ' + name + ' (' + w + '×' + h + ')');
    }

    function duplicatePattern() {
        if (!currentPatKey) return;
        var name = prompt('New name:', currentPatKey + '_copy');
        if (!name) return;
        PATTERNS[name] = PATTERNS[currentPatKey].map(function (r) { return r; });
        selectPattern(name);
        A.scheduleSave();
        status('Duplicated to: ' + name);
    }

    function deletePattern() {
        if (!currentPatKey) return;
        if (!confirm('Delete pattern "' + currentPatKey + '"?')) return;
        delete PATTERNS[currentPatKey];
        currentPatKey = null;
        renderLibrary();
        canvasEl.width = 1; canvasEl.height = 1;
        patNameLabel.textContent = '(none)';
        dimLabel.textContent = '';
        A.scheduleSave();
        status('Deleted');
    }

    function renamePattern() {
        if (!currentPatKey) return;
        var name = prompt('New name:', currentPatKey);
        if (!name || name === currentPatKey) return;
        PATTERNS[name] = PATTERNS[currentPatKey];
        delete PATTERNS[currentPatKey];
        selectPattern(name);
        A.scheduleSave();
        status('Renamed to: ' + name);
    }

    function resizePattern() {
        if (!currentPatKey) return;
        var pat = PATTERNS[currentPatKey];
        var oldW = pat[0].length, oldH = pat.length;
        var w = parseInt(prompt('New width:', oldW)) || oldW;
        var h = parseInt(prompt('New height:', oldH)) || oldH;
        if (w === oldW && h === oldH) return;

        pushHistory();
        // Nearest-neighbor resample: map each new pixel back to the source
        var newPat = [];
        for (var r = 0; r < h; r++) {
            var srcR = Math.min(Math.floor(r * oldH / h), oldH - 1);
            var row = '';
            for (var c = 0; c < w; c++) {
                var srcC = Math.min(Math.floor(c * oldW / w), oldW - 1);
                row += pat[srcR][srcC] || '.';
            }
            newPat.push(row);
        }
        PATTERNS[currentPatKey] = newPat;
        renderCanvas();
        renderLibrary();
        dimLabel.textContent = w + '×' + h + ' px';
        A.scheduleSave();
        status('Resized ' + oldW + '×' + oldH + ' → ' + w + '×' + h + ' (nearest-neighbor)');
    }

    function exportCode() {
        if (!currentPatKey) return;
        var pat = PATTERNS[currentPatKey];
        var lines = ['    PATTERNS.' + currentPatKey + ' = ['];
        for (var r = 0; r < pat.length; r++) {
            var comma = r < pat.length - 1 ? ',' : '';
            lines.push("        '" + pat[r] + "'" + comma + " // " + r);
        }
        lines.push('    ];');
        var code = lines.join('\n');
        navigator.clipboard.writeText(code).then(function () {
            status('Code copied to clipboard');
        }).catch(function () {
            prompt('Copy this code:', code);
        });
    }

    function serializeAllPatterns() {
        var out = {};
        Object.keys(PATTERNS).forEach(function (k) { out[k] = PATTERNS[k]; });
        return out;
    }

    // ── Reference image / tracer ──
    async function loadRefImage() {
        var file = await A.promptFile('image/*');
        if (!file) return;
        var url = await A.readFileAsDataURL(file);
        var img = new Image();
        img.onload = function () {
            refImg = img;
            document.getElementById('refInfo').textContent = 'Loaded: ' + img.width + '×' + img.height;
            document.getElementById('cropX').value = 0;
            document.getElementById('cropY').value = 0;
            document.getElementById('cropW').value = img.width;
            document.getElementById('cropH').value = img.height;
            // Output matches source by default; cap at 128 for very large images
            var maxDim = 128;
            if (img.width <= maxDim && img.height <= maxDim) {
                document.getElementById('outW').value = img.width;
                document.getElementById('outH').value = img.height;
            } else {
                var scale = Math.min(maxDim / img.width, maxDim / img.height);
                document.getElementById('outW').value = Math.round(img.width * scale);
                document.getElementById('outH').value = Math.round(img.height * scale);
            }
            drawRefImage();
        };
        img.src = url;
    }

    function drawRefImage() {
        if (!refImg) return;
        var dpr = window.devicePixelRatio || 1;
        var logW = refImg.width * refScale;
        var logH = refImg.height * refScale;
        refCanvasEl.width = Math.round(logW * dpr);
        refCanvasEl.height = Math.round(logH * dpr);
        refCanvasEl.style.width = logW + 'px';
        refCanvasEl.style.height = logH + 'px';
        refCanvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        refCanvasCtx.imageSmoothingEnabled = false;
        refCanvasCtx.drawImage(refImg, 0, 0, logW, logH);
        var tmp = document.createElement('canvas');
        tmp.width = refImg.width; tmp.height = refImg.height;
        var tc = tmp.getContext('2d');
        tc.drawImage(refImg, 0, 0);
        refImgData = tc.getImageData(0, 0, refImg.width, refImg.height);
        if (refScale >= 4) {
            refCanvasCtx.strokeStyle = 'rgba(255,255,255,0.12)';
            refCanvasCtx.lineWidth = 0.5;
            for (var x = 0; x <= logW; x += refScale) {
                refCanvasCtx.beginPath(); refCanvasCtx.moveTo(x, 0); refCanvasCtx.lineTo(x, logH); refCanvasCtx.stroke();
            }
            for (var y = 0; y <= logH; y += refScale) {
                refCanvasCtx.beginPath(); refCanvasCtx.moveTo(0, y); refCanvasCtx.lineTo(logW, y); refCanvasCtx.stroke();
            }
        }
        // Draw crop overlay
        var cx = (parseInt(document.getElementById('cropX').value) || 0) * refScale;
        var cy = (parseInt(document.getElementById('cropY').value) || 0) * refScale;
        var cw = (parseInt(document.getElementById('cropW').value) || 16) * refScale;
        var ch = (parseInt(document.getElementById('cropH').value) || 16) * refScale;
        // Dim area outside crop
        refCanvasCtx.fillStyle = 'rgba(0,0,0,0.5)';
        refCanvasCtx.fillRect(0, 0, logW, cy);
        refCanvasCtx.fillRect(0, cy + ch, logW, logH - cy - ch);
        refCanvasCtx.fillRect(0, cy, cx, ch);
        refCanvasCtx.fillRect(cx + cw, cy, logW - cx - cw, ch);
        // Crop border
        refCanvasCtx.strokeStyle = '#ff0';
        refCanvasCtx.lineWidth = 2;
        refCanvasCtx.setLineDash([4, 4]);
        refCanvasCtx.strokeRect(cx, cy, cw, ch);
        refCanvasCtx.setLineDash([]);
    }

    function onRefMove(e) {
        if (!refImgData) return;
        var rect = refCanvasEl.getBoundingClientRect();
        var px = Math.floor((e.clientX - rect.left) / refScale);
        var py = Math.floor((e.clientY - rect.top) / refScale);
        if (px < 0 || py < 0 || px >= refImg.width || py >= refImg.height) return;
        var idx = (py * refImg.width + px) * 4;
        var r = refImgData.data[idx], g = refImgData.data[idx + 1], b = refImgData.data[idx + 2];
        var hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
        var nearest = A.nearestPalKey(r, g, b);
        var label = '(' + px + ',' + py + ') ' + hex + ' → ' + nearest;
        if (transparentColors[hex]) label += ' [TRANSPARENT]';
        document.getElementById('refCoord').textContent = label;
    }

    function onRefClick(e) {
        if (!refImgData) return;
        var rect = refCanvasEl.getBoundingClientRect();
        var px = Math.floor((e.clientX - rect.left) / refScale);
        var py = Math.floor((e.clientY - rect.top) / refScale);
        if (px < 0 || py < 0 || px >= refImg.width || py >= refImg.height) return;
        var idx = (py * refImg.width + px) * 4;
        var r = refImgData.data[idx], g = refImgData.data[idx + 1], b = refImgData.data[idx + 2];

        if (e.shiftKey) {
            var hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
            if (transparentColors[hex]) {
                delete transparentColors[hex];
            } else {
                transparentColors[hex] = true;
            }
            renderTranspSwatches();
            return;
        }

        var nearest = A.nearestPalKey(r, g, b);
        A.activePalKey = nearest;
        renderPalette();
    }

    function renderTranspSwatches() {
        var row = document.getElementById('transpColorRow');
        if (!row) return;
        row.innerHTML = '';
        var keys = Object.keys(transparentColors);
        if (keys.length === 0) {
            var ph = el('span', { style: { fontSize: '10px', color: 'var(--muted)', fontStyle: 'italic' }, textContent: 'No colors selected' });
            row.appendChild(ph);
            return;
        }
        keys.forEach(function (hex) {
            var sw = el('span', { title: hex + ' (click to remove)', style: {
                display: 'inline-block', width: '20px', height: '20px',
                borderRadius: '3px', border: '2px solid #f55', cursor: 'pointer',
                background: hex, position: 'relative'
            }});
            // X overlay to indicate "will be transparent"
            var x = el('span', { style: {
                position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: '14px', fontWeight: 'bold',
                textShadow: '0 0 2px #000, 0 0 4px #000', pointerEvents: 'none'
            }, textContent: '×' });
            sw.appendChild(x);
            sw.addEventListener('click', function () {
                delete transparentColors[hex];
                renderTranspSwatches();
            });
            row.appendChild(sw);
        });
    }

    function traceImage() {
        var sx = parseInt(document.getElementById('cropX').value) || 0;
        var sy = parseInt(document.getElementById('cropY').value) || 0;
        var sw = parseInt(document.getElementById('cropW').value) || 16;
        var sh = parseInt(document.getElementById('cropH').value) || 16;
        var ow = parseInt(document.getElementById('outW').value) || sw;
        var oh = parseInt(document.getElementById('outH').value) || sh;

        var hasTranspColors = Object.keys(transparentColors).length > 0;
        // Build a fast lookup: tolerance-based matching for transparent colors
        var transpList = [];
        if (hasTranspColors) {
            Object.keys(transparentColors).forEach(function (hex) {
                var bigint = parseInt(hex.slice(1), 16);
                transpList.push({ r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 });
            });
        }
        function isTranspColor(pr, pg, pb) {
            for (var i = 0; i < transpList.length; i++) {
                var t = transpList[i];
                var dist = Math.abs(pr - t.r) + Math.abs(pg - t.g) + Math.abs(pb - t.b);
                if (dist < 30) return true;
            }
            return false;
        }

        var pat = [];
        for (var r = 0; r < oh; r++) {
            var row = '';
            for (var c = 0; c < ow; c++) {
                var srcX0 = sx + (c / ow) * sw;
                var srcY0 = sy + (r / oh) * sh;
                var srcX1 = sx + ((c + 1) / ow) * sw;
                var srcY1 = sy + ((r + 1) / oh) * sh;

                var totalR = 0, totalG = 0, totalB = 0, totalA = 0, count = 0, transpCount = 0;
                var px0 = Math.floor(srcX0), px1 = Math.ceil(srcX1);
                var py0 = Math.floor(srcY0), py1 = Math.ceil(srcY1);
                for (var py = py0; py < py1; py++) {
                    for (var px = px0; px < px1; px++) {
                        if (px < 0 || py < 0 || px >= refImg.width || py >= refImg.height) continue;
                        var idx = (py * refImg.width + px) * 4;
                        var pr = refImgData.data[idx], pg = refImgData.data[idx + 1], pb = refImgData.data[idx + 2];
                        if (hasTranspColors && isTranspColor(pr, pg, pb)) {
                            transpCount++;
                        }
                        totalR += pr;
                        totalG += pg;
                        totalB += pb;
                        totalA += refImgData.data[idx + 3];
                        count++;
                    }
                }

                if (count === 0 || totalA / count < 128 || (hasTranspColors && transpCount > count / 2)) {
                    row += '.';
                } else {
                    row += A.nearestPalKey(
                        Math.round(totalR / count),
                        Math.round(totalG / count),
                        Math.round(totalB / count)
                    );
                }
            }
            pat.push(row);
        }
        return pat;
    }

    function renderTracePreview(pat) {
        var pvCanvas = document.getElementById('tracePreviewCanvas');
        var pvLabel = document.getElementById('tracePreviewLabel');
        if (!pvCanvas || !pat || !pat.length) return;

        pvLabel.style.display = '';
        pvCanvas.style.display = '';

        var rows = pat.length, cols = pat[0].length;
        var scale = Math.max(2, Math.min(8, Math.floor(260 / Math.max(cols, rows))));
        var dpr = window.devicePixelRatio || 1;
        var logW = cols * scale, logH = rows * scale;
        pvCanvas.width = Math.round(logW * dpr);
        pvCanvas.height = Math.round(logH * dpr);
        pvCanvas.style.width = logW + 'px';
        pvCanvas.style.height = logH + 'px';
        var ctx = pvCanvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                var ch = pat[r][c];
                var color = PAL[ch];
                if (!color) {
                    ctx.fillStyle = ((r + c) % 2 === 0) ? '#1a1a2e' : '#222238';
                } else {
                    ctx.fillStyle = color;
                }
                ctx.fillRect(c * scale, r * scale, scale, scale);
            }
        }
    }

    function autoTracePreview() {
        if (!refImgData) { alert('Load a reference image first'); return; }
        tracedPreview = traceImage();
        renderTracePreview(tracedPreview);

        var btn = document.getElementById('applyTraceBtn');
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }

        var ow = tracedPreview[0].length, oh = tracedPreview.length;
        status('Trace preview ready (' + ow + '×' + oh + '). Click "Apply to Sprite" to use it.');
    }

    function applyTrace() {
        if (!tracedPreview) { alert('Run Preview Trace first'); return; }

        if (!currentPatKey) {
            var name = prompt('Pattern name for traced sprite:', 'traced_sprite');
            if (!name) return;
            var blank = [];
            for (var rr = 0; rr < tracedPreview.length; rr++) blank.push('.'.repeat(tracedPreview[0].length));
            PATTERNS[name] = blank;
            selectPattern(name);
        }

        pushHistory();
        PATTERNS[currentPatKey] = tracedPreview;
        tracedPreview = null;
        renderCanvas();
        renderLibrary();
        dimLabel.textContent = PATTERNS[currentPatKey][0].length + '×' + PATTERNS[currentPatKey].length + ' px';
        A.scheduleSave();

        var btn = document.getElementById('applyTraceBtn');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }
        var pvCanvas = document.getElementById('tracePreviewCanvas');
        var pvLabel = document.getElementById('tracePreviewLabel');
        if (pvCanvas) pvCanvas.style.display = 'none';
        if (pvLabel) pvLabel.style.display = 'none';

        status('Trace applied to ' + currentPatKey);
    }

    function resetToDefault() {
        if (!currentPatKey) { alert('No pattern selected'); return; }
        if (!defaultPatterns[currentPatKey]) {
            alert('No default found for "' + currentPatKey + '". This pattern was created in the admin.');
            return;
        }
        if (!confirm('Reset "' + currentPatKey + '" to its original game.js default? Your edits will be lost.')) return;

        pushHistory();
        PATTERNS[currentPatKey] = defaultPatterns[currentPatKey].map(function (r) { return r; });
        renderCanvas();
        renderLibrary();
        dimLabel.textContent = PATTERNS[currentPatKey][0].length + '×' + PATTERNS[currentPatKey].length + ' px';
        A.scheduleSave();
        status('Reset "' + currentPatKey + '" to default');
    }

    function status(msg) {
        if (statusEl) statusEl.textContent = msg;
    }

    // ── Register ──
    A.registerTab('sprites', init, function () { renderCanvas(); });
})();
