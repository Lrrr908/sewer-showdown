/* ================================================================
   admin-ripper.js — Sprite Sheet Ripper Tab
   Load sprite sheets, auto-detect sprites, extract to NES patterns
   ================================================================ */

(function () {
    'use strict';
    var A = Admin;
    var PAL = A.PAL, PATTERNS;
    var el = A.el;

    var sheetImg = null, sheetData = null;
    var sheetCanvas, sheetCtx;
    var zoom = 3;
    var bgColor = null; // { r, g, b } — auto-detected or user-picked
    var bgThreshold = 30;

    // Manual selection state
    var selStart = null, selEnd = null, isDragging = false;
    var dragMode = 'none'; // 'none', 'drawing', 'moving', 'resizing'
    var activeHandle = null;
    var dragOrigin = null; // { x, y } pixel coords at drag start
    var selSnapshot = null; // copy of active selection at drag start
    var activeSelIdx = -1;
    var selections = []; // [{ x, y, w, h, name }]
    var canvasWrap;

    // Sheet library: [{ name, dataURL, width, height }]
    var sheetLibrary = [];
    var activeSheetIdx = -1;
    var sheetLibEl;

    var showGrid = false;
    var statusEl, spriteListEl, previewCanvas, previewCtx;

    function getPatterns() {
        if (typeof NES !== 'undefined' && NES.PATTERNS) return NES.PATTERNS;
        return A.PATTERNS;
    }

    function init() {
        PATTERNS = getPatterns();
        var panel = document.getElementById('tab-ripper');
        panel.innerHTML = '';
        panel.style.flexDirection = 'row';

        // Left: sheet canvas
        var left = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' } });
        var toolbar = el('div', { style: { padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } });

        toolbar.appendChild(el('button', { className: 'btn small primary', textContent: 'Load File', onClick: loadSheet }));

        // Quick-load from known game sprite sheets
        var quickSel = el('select', { id: 'ripQuickSheet' });
        quickSel.appendChild(el('option', { value: '', textContent: '— Quick Load —' }));
        var knownSheets = [
            { v: 'sprites/turtles.png', t: 'turtles.png' },
            { v: 'sprites/area1.png', t: 'area1.png' },
            { v: 'sprites/enemies.png', t: 'enemies.png' },
            { v: 'sprites/items.png', t: 'items.png' },
            { v: 'sprites/title.png', t: 'title.png' },
            { v: 'sprites/shredder.png', t: 'shredder.png' },
            { v: 'sprites/technodrome.png', t: 'technodrome.png' }
        ];
        knownSheets.forEach(function (s) { quickSel.appendChild(el('option', { value: s.v, textContent: s.t })); });
        quickSel.addEventListener('change', function () { if (this.value) quickLoadSheet(this.value); this.selectedIndex = 0; });
        toolbar.appendChild(quickSel);

        var zoomSel = el('select', { id: 'ripZoomSel' });
        [1, 2, 3, 4, 6, 8, 10].forEach(function (z) {
            var opt = el('option', { value: String(z), textContent: z + 'x' });
            if (z === zoom) opt.selected = true;
            zoomSel.appendChild(opt);
        });
        zoomSel.addEventListener('change', function () { zoom = parseInt(this.value); renderSheet(); });
        toolbar.appendChild(el('span', {}, [' Zoom: ', zoomSel]));

        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Auto-Detect', onClick: autoDetect }));
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Detect Grid', onClick: detectGridSize }));
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Group Similar', onClick: groupSimilar }));

        // Grid size for uniform sprite sheets
        toolbar.appendChild(el('span', { style: { color: 'var(--muted)', fontSize: '10px' } }, [' Grid: ']));
        var gridWSel = el('select', { id: 'ripGridW' });
        var gridHSel = el('select', { id: 'ripGridH' });
        [8, 16, 24, 32, 48, 64].forEach(function (v) {
            var oW = el('option', { value: String(v), textContent: String(v) }); if (v === 16) oW.selected = true;
            var oH = el('option', { value: String(v), textContent: String(v) }); if (v === 16) oH.selected = true;
            gridWSel.appendChild(oW); gridHSel.appendChild(oH);
        });
        toolbar.appendChild(gridWSel);
        toolbar.appendChild(el('span', { style: { color: 'var(--muted)', fontSize: '10px' } }, ['×']));
        toolbar.appendChild(gridHSel);
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Grid Select All', onClick: gridSelectAll }));
        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Show Grid', onClick: function () { showGrid = !showGrid; this.textContent = showGrid ? 'Hide Grid' : 'Show Grid'; renderSheet(); } }));

        toolbar.appendChild(el('button', { className: 'btn small', textContent: 'Clear Selections', onClick: clearSelections }));

        left.appendChild(toolbar);

        canvasWrap = el('div', { style: { flex: '1', overflow: 'auto', background: '#111', position: 'relative', cursor: 'crosshair' } });
        sheetCanvas = el('canvas', { style: { imageRendering: 'pixelated' } });
        sheetCtx = sheetCanvas.getContext('2d');
        canvasWrap.appendChild(sheetCanvas);
        left.appendChild(canvasWrap);

        sheetCanvas.addEventListener('mousedown', onSheetDown);
        sheetCanvas.addEventListener('mousemove', onSheetMove);
        window.addEventListener('mouseup', onSheetUp);
        sheetCanvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        // Scroll-wheel zoom centered on mouse
        canvasWrap.addEventListener('wheel', function (e) {
            if (!sheetImg) return;
            e.preventDefault();
            var oldZoom = zoom;
            var newZoom = e.deltaY < 0 ? zoom + 1 : zoom - 1;
            newZoom = Math.max(1, Math.min(10, newZoom));
            if (newZoom === oldZoom) return;

            // Keep mouse point stationary
            var scrollLeft = canvasWrap.scrollLeft;
            var scrollTop = canvasWrap.scrollTop;
            var rect = canvasWrap.getBoundingClientRect();
            var viewX = e.clientX - rect.left;
            var viewY = e.clientY - rect.top;
            var contentX = scrollLeft + viewX;
            var contentY = scrollTop + viewY;
            var ratio = newZoom / oldZoom;

            zoom = newZoom;
            // Update zoom selector if exists
            var zSel = document.getElementById('ripZoomSel');
            if (zSel) zSel.value = String(zoom);
            renderSheet();
            canvasWrap.scrollLeft = contentX * ratio - viewX;
            canvasWrap.scrollTop = contentY * ratio - viewY;
        });

        statusEl = el('div', { className: 'status-msg', style: { padding: '4px 8px', fontSize: '11px' } });
        left.appendChild(statusEl);
        left.appendChild(el('div', { style: { padding: '2px 8px', fontSize: '9px', color: 'var(--muted)' },
            textContent: 'Scroll=zoom | Drag=select | Click sel=move | Edges=resize | Arrows=nudge (Shift×10) | Right-click=pick BG | +/-=zoom | Del=remove | Ctrl+C=coords | Ctrl+S=png' }));

        // Right: controls + sprite list
        var right = el('div', { style: { width: '280px', overflowY: 'auto', padding: '10px', borderLeft: '1px solid var(--border)', background: 'var(--surface)' } });

        right.appendChild(el('div', { className: 'panel-title', textContent: 'Loaded Sheets' }));
        sheetLibEl = el('div', { id: 'ripSheetLib', style: { maxHeight: '120px', overflowY: 'auto', marginBottom: '8px' } });
        right.appendChild(sheetLibEl);

        right.appendChild(el('hr'));
        right.appendChild(el('div', { className: 'panel-title', textContent: 'Background Color' }));
        right.appendChild(el('div', { style: { fontSize: '10px', color: 'var(--muted)', marginBottom: '4px' }, textContent: 'Right-click a pixel on the sheet to pick, or:' }));

        var bgRow = el('div', { className: 'row', style: { gap: '4px', alignItems: 'center' } });
        var bgSwatch = el('div', { id: 'ripBgSwatch', style: { width: '24px', height: '24px', border: '2px solid var(--border)', background: '#93bbec' } });
        bgRow.appendChild(bgSwatch);
        bgRow.appendChild(el('button', { className: 'btn small', textContent: 'Auto-Detect BG', onClick: autoDetectBg }));
        right.appendChild(bgRow);

        var threshRow = el('div', { className: 'row', style: { gap: '4px', alignItems: 'center', marginTop: '4px' } });
        threshRow.appendChild(el('label', { style: { fontSize: '10px' }, textContent: 'Threshold:' }));
        var threshInp = el('input', { type: 'range', min: '0', max: '100', value: String(bgThreshold), style: { flex: '1' } });
        var threshVal = el('span', { style: { fontSize: '10px', minWidth: '24px' }, textContent: String(bgThreshold) });
        threshInp.addEventListener('input', function () {
            bgThreshold = parseInt(this.value);
            threshVal.textContent = this.value;
        });
        threshRow.appendChild(threshInp);
        threshRow.appendChild(threshVal);
        right.appendChild(threshRow);

        right.appendChild(el('hr'));
        right.appendChild(el('div', { className: 'panel-title', textContent: 'Detected / Selected Sprites' }));
        right.appendChild(el('div', { style: { fontSize: '10px', color: 'var(--muted)', marginBottom: '4px' }, textContent: 'Click+drag on sheet to select, or use Auto-Detect.' }));

        spriteListEl = el('div', { id: 'ripSpriteList', style: { maxHeight: '300px', overflowY: 'auto' } });
        right.appendChild(spriteListEl);

        right.appendChild(el('hr'));
        right.appendChild(el('div', { className: 'panel-title', textContent: 'Extract' }));

        var extractRow = el('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } });
        extractRow.appendChild(el('button', { className: 'btn small success', textContent: 'Extract All → Patterns', onClick: extractAll }));
        extractRow.appendChild(el('button', { className: 'btn small', textContent: 'Export as JSON', onClick: exportJSON }));
        extractRow.appendChild(el('button', { className: 'btn small', textContent: 'Copy Coords', onClick: copyActiveCoords }));
        extractRow.appendChild(el('button', { className: 'btn small', textContent: 'Download PNG', onClick: downloadActivePNG }));
        right.appendChild(extractRow);

        right.appendChild(el('hr'));
        right.appendChild(el('div', { className: 'panel-title', textContent: 'Preview' }));
        previewCanvas = el('canvas', { style: { maxWidth: '100%', border: '1px solid var(--border)', background: '#000', imageRendering: 'pixelated' } });
        previewCtx = previewCanvas.getContext('2d');
        right.appendChild(previewCanvas);

        panel.appendChild(left);
        panel.appendChild(right);

        // Default BG
        bgColor = { r: 0x93, g: 0xbb, b: 0xec };

        renderSheetLib();
    }

    // ── Sheet loading ──
    async function loadSheet() {
        var file = await A.promptFile('image/*');
        if (!file) return;
        var url = await A.readFileAsDataURL(file);
        var img = new Image();
        img.onload = function () {
            var entry = { name: file.name, dataURL: url, width: img.width, height: img.height, img: img };
            sheetLibrary.push(entry);
            activateSheet(sheetLibrary.length - 1);
            renderSheetLib();
            status('Loaded: ' + img.width + '×' + img.height + ' — ' + file.name);
        };
        img.src = url;
    }

    function quickLoadSheet(url) {
        var img = new Image();
        img.onload = function () {
            var entry = { name: url.split('/').pop(), dataURL: url, width: img.width, height: img.height, img: img };
            sheetLibrary.push(entry);
            activateSheet(sheetLibrary.length - 1);
            renderSheetLib();
            status('Loaded: ' + img.width + '×' + img.height + ' — ' + entry.name);
        };
        img.onerror = function () { status('Failed to load: ' + url); };
        img.src = url;
    }

    function activateSheet(idx) {
        if (idx < 0 || idx >= sheetLibrary.length) return;
        activeSheetIdx = idx;
        var entry = sheetLibrary[idx];
        sheetImg = entry.img;
        var tmp = document.createElement('canvas');
        tmp.width = entry.width; tmp.height = entry.height;
        var tc = tmp.getContext('2d');
        tc.drawImage(entry.img, 0, 0);
        sheetData = tc.getImageData(0, 0, entry.width, entry.height);
        selections = [];
        autoDetectBg();
        renderSheet();
        renderSpriteList();
        renderSheetLib();
    }

    function renderSheetLib() {
        if (!sheetLibEl) return;
        sheetLibEl.innerHTML = '';
        if (sheetLibrary.length === 0) {
            sheetLibEl.appendChild(el('div', { style: { fontSize: '10px', color: 'var(--muted)', padding: '4px' }, textContent: 'No sheets loaded. Click "Load Sprite Sheet".' }));
            return;
        }
        sheetLibrary.forEach(function (entry, i) {
            var row = el('div', { style: {
                display: 'flex', gap: '4px', alignItems: 'center', padding: '3px 4px',
                borderBottom: '1px solid var(--border)', cursor: 'pointer',
                background: i === activeSheetIdx ? 'var(--accent-dim, rgba(100,170,255,0.15))' : 'transparent'
            }});
            // Thumbnail
            var thumb = el('canvas', { style: { width: '28px', height: '28px', imageRendering: 'pixelated', border: '1px solid var(--border)', flexShrink: '0' } });
            var tScale = Math.min(28 / entry.width, 28 / entry.height);
            thumb.width = Math.round(entry.width * tScale);
            thumb.height = Math.round(entry.height * tScale);
            var tc = thumb.getContext('2d');
            tc.imageSmoothingEnabled = false;
            tc.drawImage(entry.img, 0, 0, thumb.width, thumb.height);
            row.appendChild(thumb);

            row.appendChild(el('div', { style: { flex: '1', minWidth: '0' } }, [
                el('div', { style: { fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, textContent: entry.name }),
                el('div', { style: { fontSize: '9px', color: 'var(--muted)' }, textContent: entry.width + '×' + entry.height })
            ]));

            var rmBtn = el('button', { className: 'btn small', textContent: '×', style: { padding: '2px 6px' }, onClick: function (e) {
                e.stopPropagation();
                sheetLibrary.splice(i, 1);
                if (activeSheetIdx === i) {
                    activeSheetIdx = -1; sheetImg = null; sheetData = null; selections = [];
                    renderSheet(); renderSpriteList();
                } else if (activeSheetIdx > i) { activeSheetIdx--; }
                renderSheetLib();
            }});
            row.appendChild(rmBtn);

            row.addEventListener('click', function () { activateSheet(i); });
            sheetLibEl.appendChild(row);
        });
    }

    // ── Background detection ──
    function autoDetectBg() {
        if (!sheetData) return;
        // Most common color in corners
        var corners = [
            [0, 0], [sheetImg.width - 1, 0],
            [0, sheetImg.height - 1], [sheetImg.width - 1, sheetImg.height - 1]
        ];
        var counts = {};
        corners.forEach(function (p) {
            var idx = (p[1] * sheetImg.width + p[0]) * 4;
            var key = sheetData.data[idx] + ',' + sheetData.data[idx + 1] + ',' + sheetData.data[idx + 2];
            counts[key] = (counts[key] || 0) + 1;
        });
        // Also sample edges
        for (var x = 0; x < sheetImg.width; x += Math.max(1, Math.floor(sheetImg.width / 20))) {
            var idx = x * 4;
            var key = sheetData.data[idx] + ',' + sheetData.data[idx + 1] + ',' + sheetData.data[idx + 2];
            counts[key] = (counts[key] || 0) + 1;
        }
        var best = null, bestCount = 0;
        for (var k in counts) {
            if (counts[k] > bestCount) { bestCount = counts[k]; best = k; }
        }
        if (best) {
            var parts = best.split(',');
            bgColor = { r: parseInt(parts[0]), g: parseInt(parts[1]), b: parseInt(parts[2]) };
            var swatch = document.getElementById('ripBgSwatch');
            if (swatch) swatch.style.background = 'rgb(' + bgColor.r + ',' + bgColor.g + ',' + bgColor.b + ')';
            status('Background: #' + ((1 << 24) + (bgColor.r << 16) + (bgColor.g << 8) + bgColor.b).toString(16).slice(1));
        }
    }

    function isBgPixel(idx) {
        if (!bgColor || !sheetData) return false;
        var d = sheetData.data;
        if (d[idx + 3] < 128) return true;
        var dr = d[idx] - bgColor.r, dg = d[idx + 1] - bgColor.g, db = d[idx + 2] - bgColor.b;
        return Math.sqrt(dr * dr + dg * dg + db * db) <= bgThreshold;
    }

    // ── Rendering ──
    function renderSheet() {
        if (!sheetImg) {
            sheetCanvas.width = 400; sheetCanvas.height = 200;
            sheetCtx.fillStyle = '#1a1a2e';
            sheetCtx.fillRect(0, 0, 400, 200);
            sheetCtx.fillStyle = '#666';
            sheetCtx.font = '14px system-ui';
            sheetCtx.textAlign = 'center';
            sheetCtx.fillText('Load a sprite sheet to begin', 200, 100);
            return;
        }
        var w = sheetImg.width * zoom, h = sheetImg.height * zoom;
        sheetCanvas.width = w; sheetCanvas.height = h;
        sheetCtx.imageSmoothingEnabled = false;
        sheetCtx.drawImage(sheetImg, 0, 0, w, h);

        // Pixel grid at high zoom
        if (zoom >= 4) {
            sheetCtx.strokeStyle = 'rgba(255,255,255,0.06)';
            sheetCtx.lineWidth = 0.5;
            for (var x = 0; x <= w; x += zoom) {
                sheetCtx.beginPath(); sheetCtx.moveTo(x, 0); sheetCtx.lineTo(x, h); sheetCtx.stroke();
            }
            for (var y = 0; y <= h; y += zoom) {
                sheetCtx.beginPath(); sheetCtx.moveTo(0, y); sheetCtx.lineTo(w, y); sheetCtx.stroke();
            }
        }

        // Grid overlay
        if (showGrid) {
            var gw = parseInt(document.getElementById('ripGridW').value) || 16;
            var gh = parseInt(document.getElementById('ripGridH').value) || 16;
            sheetCtx.strokeStyle = 'rgba(0,200,255,0.3)';
            sheetCtx.lineWidth = 1;
            for (var gx = 0; gx <= sheetImg.width; gx += gw) {
                sheetCtx.beginPath(); sheetCtx.moveTo(gx * zoom, 0); sheetCtx.lineTo(gx * zoom, h); sheetCtx.stroke();
            }
            for (var gy = 0; gy <= sheetImg.height; gy += gh) {
                sheetCtx.beginPath(); sheetCtx.moveTo(0, gy * zoom); sheetCtx.lineTo(w, gy * zoom); sheetCtx.stroke();
            }
        }

        // Draw selections (color-coded by group when grouped)
        selections.forEach(function (s, i) {
            var isActive = (i === activeSelIdx);
            var groupColor = (s.group !== undefined) ? GROUP_COLORS[s.group % GROUP_COLORS.length] : '#ff0';
            sheetCtx.strokeStyle = isActive ? '#fff' : groupColor;
            sheetCtx.lineWidth = isActive ? 2 : 1;
            sheetCtx.setLineDash(isActive ? [] : [4, 3]);
            sheetCtx.strokeRect(s.x * zoom, s.y * zoom, s.w * zoom, s.h * zoom);
            sheetCtx.setLineDash([]);
            // Label
            var labelW = Math.max(40, s.name.length * 6);
            sheetCtx.fillStyle = 'rgba(0,0,0,0.7)';
            sheetCtx.fillRect(s.x * zoom, s.y * zoom - 14, labelW, 14);
            sheetCtx.fillStyle = isActive ? '#fff' : groupColor;
            sheetCtx.font = '10px monospace';
            sheetCtx.textAlign = 'left';
            sheetCtx.fillText(s.name || ('#' + i), s.x * zoom + 2, s.y * zoom - 3);
            // Resize handles for active selection
            if (isActive) {
                var hSize = Math.max(3, Math.min(6, zoom));
                var corners = [
                    [s.x * zoom, s.y * zoom], [s.x * zoom + s.w * zoom, s.y * zoom],
                    [s.x * zoom, s.y * zoom + s.h * zoom], [s.x * zoom + s.w * zoom, s.y * zoom + s.h * zoom]
                ];
                sheetCtx.fillStyle = '#fff';
                corners.forEach(function (c) {
                    sheetCtx.fillRect(c[0] - hSize / 2, c[1] - hSize / 2, hSize, hSize);
                });
            }
        });

        // Current drag selection
        if (isDragging && selStart && selEnd) {
            var sx = Math.min(selStart.x, selEnd.x) * zoom;
            var sy = Math.min(selStart.y, selEnd.y) * zoom;
            var sw = (Math.abs(selEnd.x - selStart.x) + 1) * zoom;
            var sh = (Math.abs(selEnd.y - selStart.y) + 1) * zoom;
            sheetCtx.strokeStyle = '#0f0';
            sheetCtx.lineWidth = 2;
            sheetCtx.setLineDash([3, 3]);
            sheetCtx.strokeRect(sx, sy, sw, sh);
            sheetCtx.setLineDash([]);
        }
    }

    // ── Mouse handling ──
    function pixelAt(e) {
        var rect = sheetCanvas.getBoundingClientRect();
        return {
            x: Math.floor((e.clientX - rect.left) / zoom),
            y: Math.floor((e.clientY - rect.top) / zoom)
        };
    }

    function hitTestHandle(p) {
        if (activeSelIdx < 0 || activeSelIdx >= selections.length) return null;
        var s = selections[activeSelIdx];
        var gr = 3; // grab radius in pixels
        var onLeft = Math.abs(p.x - s.x) <= gr;
        var onRight = Math.abs(p.x - (s.x + s.w)) <= gr;
        var onTop = Math.abs(p.y - s.y) <= gr;
        var onBottom = Math.abs(p.y - (s.y + s.h)) <= gr;
        var inX = p.x >= s.x - gr && p.x <= s.x + s.w + gr;
        var inY = p.y >= s.y - gr && p.y <= s.y + s.h + gr;
        if (onTop && onLeft) return 'top-left';
        if (onTop && onRight) return 'top-right';
        if (onBottom && onLeft) return 'bottom-left';
        if (onBottom && onRight) return 'bottom-right';
        if (onTop && inX) return 'top';
        if (onBottom && inX) return 'bottom';
        if (onLeft && inY) return 'left';
        if (onRight && inY) return 'right';
        return null;
    }

    function hitTestSelection(p) {
        for (var i = selections.length - 1; i >= 0; i--) {
            var s = selections[i];
            if (p.x >= s.x && p.x < s.x + s.w && p.y >= s.y && p.y < s.y + s.h) return i;
        }
        return -1;
    }

    function onSheetDown(e) {
        if (!sheetImg) return;
        e.preventDefault();

        // Right-click: pick background color
        if (e.button === 2) {
            var p = pixelAt(e);
            if (p.x >= 0 && p.y >= 0 && p.x < sheetImg.width && p.y < sheetImg.height) {
                var idx = (p.y * sheetImg.width + p.x) * 4;
                bgColor = { r: sheetData.data[idx], g: sheetData.data[idx + 1], b: sheetData.data[idx + 2] };
                var swatch = document.getElementById('ripBgSwatch');
                if (swatch) swatch.style.background = 'rgb(' + bgColor.r + ',' + bgColor.g + ',' + bgColor.b + ')';
                status('BG color picked: rgb(' + bgColor.r + ',' + bgColor.g + ',' + bgColor.b + ')');
            }
            return;
        }

        var p = pixelAt(e);
        dragOrigin = p;

        // Check if clicking on a resize handle of the active selection
        var handle = hitTestHandle(p);
        if (handle) {
            dragMode = 'resizing';
            activeHandle = handle;
            selSnapshot = { x: selections[activeSelIdx].x, y: selections[activeSelIdx].y, w: selections[activeSelIdx].w, h: selections[activeSelIdx].h };
            return;
        }

        // Check if clicking inside an existing selection (move it)
        var hitIdx = hitTestSelection(p);
        if (hitIdx >= 0) {
            activeSelIdx = hitIdx;
            dragMode = 'moving';
            selSnapshot = { x: selections[hitIdx].x, y: selections[hitIdx].y, w: selections[hitIdx].w, h: selections[hitIdx].h };
            previewSprite(hitIdx);
            renderSheet();
            renderSpriteList();
            return;
        }

        // Start drawing a new selection
        dragMode = 'drawing';
        selStart = p;
        selEnd = p;
        isDragging = true;
    }

    function onSheetMove(e) {
        if (!sheetImg) return;
        var p = pixelAt(e);

        if (dragMode === 'drawing') {
            selEnd = p;
            renderSheet();
            var w = Math.abs(selEnd.x - selStart.x) + 1;
            var h = Math.abs(selEnd.y - selStart.y) + 1;
            status('Selecting: ' + w + '×' + h + ' at (' + Math.min(selStart.x, selEnd.x) + ',' + Math.min(selStart.y, selEnd.y) + ')');
        } else if (dragMode === 'moving' && activeSelIdx >= 0) {
            var dx = p.x - dragOrigin.x, dy = p.y - dragOrigin.y;
            var s = selections[activeSelIdx];
            s.x = Math.max(0, selSnapshot.x + dx);
            s.y = Math.max(0, selSnapshot.y + dy);
            if (sheetImg) {
                s.x = Math.min(s.x, sheetImg.width - s.w);
                s.y = Math.min(s.y, sheetImg.height - s.h);
            }
            renderSheet();
            status('Moving: (' + s.x + ',' + s.y + ') ' + s.w + '×' + s.h);
        } else if (dragMode === 'resizing' && activeSelIdx >= 0) {
            var dx = p.x - dragOrigin.x, dy = p.y - dragOrigin.y;
            var s = selections[activeSelIdx];
            var nx = selSnapshot.x, ny = selSnapshot.y, nw = selSnapshot.w, nh = selSnapshot.h;
            if (activeHandle.includes('left')) { nx = Math.min(selSnapshot.x + dx, selSnapshot.x + selSnapshot.w - 1); nw = selSnapshot.w - (nx - selSnapshot.x); }
            if (activeHandle.includes('right')) { nw = Math.max(1, selSnapshot.w + dx); }
            if (activeHandle.includes('top')) { ny = Math.min(selSnapshot.y + dy, selSnapshot.y + selSnapshot.h - 1); nh = selSnapshot.h - (ny - selSnapshot.y); }
            if (activeHandle.includes('bottom')) { nh = Math.max(1, selSnapshot.h + dy); }
            s.x = Math.max(0, nx); s.y = Math.max(0, ny);
            s.w = Math.max(1, nw); s.h = Math.max(1, nh);
            renderSheet();
            status('Resizing: (' + s.x + ',' + s.y + ') ' + s.w + '×' + s.h);
        } else {
            // Hover: show pixel info + cursor hint
            if (p.x >= 0 && p.y >= 0 && p.x < sheetImg.width && p.y < sheetImg.height) {
                var idx = (p.y * sheetImg.width + p.x) * 4;
                var r = sheetData.data[idx], g = sheetData.data[idx + 1], b = sheetData.data[idx + 2];
                var hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
                var isBg = isBgPixel(idx) ? ' [BG]' : '';
                status('(' + p.x + ',' + p.y + ') ' + hex + ' → ' + A.nearestPalKey(r, g, b) + isBg);
            }
            // Update cursor
            var handle = hitTestHandle(p);
            if (handle) {
                var curMap = { 'top': 'n-resize', 'bottom': 's-resize', 'left': 'w-resize', 'right': 'e-resize',
                    'top-left': 'nw-resize', 'top-right': 'ne-resize', 'bottom-left': 'sw-resize', 'bottom-right': 'se-resize' };
                sheetCanvas.style.cursor = curMap[handle] || 'crosshair';
            } else if (hitTestSelection(p) >= 0) {
                sheetCanvas.style.cursor = 'move';
            } else {
                sheetCanvas.style.cursor = 'crosshair';
            }
        }
    }

    function onSheetUp(e) {
        if (dragMode === 'drawing') {
            isDragging = false;
            var x0 = Math.min(selStart.x, selEnd.x);
            var y0 = Math.min(selStart.y, selEnd.y);
            var w = Math.abs(selEnd.x - selStart.x) + 1;
            var h = Math.abs(selEnd.y - selStart.y) + 1;

            if (w >= 2 && h >= 2) {
                var name = 'sprite_' + x0 + '_' + y0 + '_' + w + 'x' + h;
                selections.push({ x: x0, y: y0, w: w, h: h, name: name });
                activeSelIdx = selections.length - 1;
                renderSpriteList();
                previewSprite(activeSelIdx);
            }
            selStart = null; selEnd = null;
        } else if (dragMode === 'moving' || dragMode === 'resizing') {
            if (activeSelIdx >= 0) {
                var s = selections[activeSelIdx];
                s.name = 'sprite_' + s.x + '_' + s.y + '_' + s.w + 'x' + s.h;
                previewSprite(activeSelIdx);
                renderSpriteList();
            }
        }
        dragMode = 'none';
        activeHandle = null;
        selSnapshot = null;
        renderSheet();
    }

    function trimToBounds(x0, y0, w, h) {
        if (!sheetData) return { x: x0, y: y0, w: w, h: h };
        var minX = x0 + w, minY = y0 + h, maxX = x0, maxY = y0;
        for (var y = y0; y < y0 + h; y++) {
            for (var x = x0; x < x0 + w; x++) {
                var idx = (y * sheetImg.width + x) * 4;
                if (!isBgPixel(idx)) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < minX) return { x: x0, y: y0, w: 0, h: 0 };
        return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    // ── Auto-detect sprites ──
    function autoDetect() {
        if (!sheetData || !bgColor) { alert('Load a sheet and set background color first.'); return; }
        status('Detecting sprites...');

        var w = sheetImg.width, h = sheetImg.height;
        var visited = new Uint8Array(w * h);
        var found = [];

        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                if (visited[y * w + x]) continue;
                var idx = (y * w + x) * 4;
                if (isBgPixel(idx)) { visited[y * w + x] = 1; continue; }

                // Flood-fill to find connected non-bg region
                var bounds = floodFill(x, y, w, h, visited);
                if (bounds.w >= 4 && bounds.h >= 4) {
                    found.push(bounds);
                }
            }
        }

        // Merge overlapping or adjacent bounds
        found = mergeBounds(found);

        selections = [];
        found.forEach(function (b, i) {
            selections.push({
                x: b.x, y: b.y, w: b.w, h: b.h,
                name: 'sprite_' + b.x + '_' + b.y + '_' + b.w + 'x' + b.h
            });
        });

        renderSheet();
        renderSpriteList();
        status('Found ' + selections.length + ' sprites');
    }

    function floodFill(sx, sy, w, h, visited) {
        var stack = [[sx, sy]];
        var minX = sx, maxX = sx, minY = sy, maxY = sy;
        while (stack.length > 0) {
            var p = stack.pop();
            var px = p[0], py = p[1];
            if (px < 0 || py < 0 || px >= w || py >= h) continue;
            var key = py * w + px;
            if (visited[key]) continue;
            visited[key] = 1;
            var idx = (py * w + px) * 4;
            if (isBgPixel(idx)) continue;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
        }
        return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    function mergeBounds(bounds) {
        // Merge bounds that overlap or are within 2px
        var merged = true;
        while (merged) {
            merged = false;
            for (var i = 0; i < bounds.length; i++) {
                for (var j = i + 1; j < bounds.length; j++) {
                    var a = bounds[i], b = bounds[j];
                    var pad = 2;
                    if (a.x - pad <= b.x + b.w && a.x + a.w + pad >= b.x &&
                        a.y - pad <= b.y + b.h && a.y + a.h + pad >= b.y) {
                        var nx = Math.min(a.x, b.x), ny = Math.min(a.y, b.y);
                        bounds[i] = {
                            x: nx, y: ny,
                            w: Math.max(a.x + a.w, b.x + b.w) - nx,
                            h: Math.max(a.y + a.h, b.y + b.h) - ny
                        };
                        bounds.splice(j, 1);
                        merged = true;
                        break;
                    }
                }
                if (merged) break;
            }
        }
        return bounds;
    }

    // ── Auto grid detection ──
    // Scans rows and columns for solid background lines to infer cell size
    function detectGridSize() {
        if (!sheetData || !bgColor) { alert('Load a sheet and set background color first.'); return; }
        var w = sheetImg.width, h = sheetImg.height;

        // Find horizontal gap rows (full-width bg rows)
        var hGaps = [];
        for (var y = 0; y < h; y++) {
            var allBg = true;
            for (var x = 0; x < w && allBg; x += Math.max(1, Math.floor(w / 40))) {
                if (!isBgPixel((y * w + x) * 4)) allBg = false;
            }
            if (allBg) hGaps.push(y);
        }
        // Find vertical gap columns
        var vGaps = [];
        for (var x = 0; x < w; x++) {
            var allBg = true;
            for (var y = 0; y < h && allBg; y += Math.max(1, Math.floor(h / 40))) {
                if (!isBgPixel((y * w + x) * 4)) allBg = false;
            }
            if (allBg) vGaps.push(x);
        }

        // Find most common gap interval
        var cellH = findDominantInterval(hGaps, h);
        var cellW = findDominantInterval(vGaps, w);

        if (cellW < 4 || cellH < 4) {
            // Fallback: analyze detected sprites for common dimensions
            if (selections.length > 2) {
                var wHist = {}, hHist = {};
                selections.forEach(function (s) {
                    var rw = roundToGrid(s.w); var rh = roundToGrid(s.h);
                    wHist[rw] = (wHist[rw] || 0) + 1;
                    hHist[rh] = (hHist[rh] || 0) + 1;
                });
                cellW = parseInt(Object.keys(wHist).sort(function (a, b) { return wHist[b] - wHist[a]; })[0]) || 16;
                cellH = parseInt(Object.keys(hHist).sort(function (a, b) { return hHist[b] - hHist[a]; })[0]) || 16;
            } else {
                status('Could not auto-detect grid. Try manually.');
                return;
            }
        }

        // Set grid dropdowns
        setGridDropdown('ripGridW', cellW);
        setGridDropdown('ripGridH', cellH);
        showGrid = true;
        renderSheet();
        status('Detected grid: ' + cellW + '×' + cellH);
    }

    function findDominantInterval(gaps, total) {
        if (gaps.length < 2) return 0;
        // Group consecutive gap rows into "band starts"
        var bands = [gaps[0]];
        for (var i = 1; i < gaps.length; i++) {
            if (gaps[i] - gaps[i - 1] > 1) bands.push(gaps[i]);
        }
        if (bands.length < 2) return 0;
        // Find most common interval between band starts
        var intervals = {};
        for (var i = 1; i < bands.length; i++) {
            var d = bands[i] - bands[i - 1];
            if (d >= 4) intervals[d] = (intervals[d] || 0) + 1;
        }
        var best = 0, bestCount = 0;
        for (var k in intervals) {
            if (intervals[k] > bestCount) { bestCount = intervals[k]; best = parseInt(k); }
        }
        return best;
    }

    function roundToGrid(v) {
        var steps = [8, 16, 24, 32, 48, 64];
        var best = v, bestD = 999;
        for (var i = 0; i < steps.length; i++) {
            var d = Math.abs(v - steps[i]);
            if (d < bestD) { bestD = d; best = steps[i]; }
        }
        return best;
    }

    function setGridDropdown(id, val) {
        var sel = document.getElementById(id);
        if (!sel) return;
        // Add the value if not in options
        var found = false;
        for (var i = 0; i < sel.options.length; i++) {
            if (parseInt(sel.options[i].value) === val) { sel.selectedIndex = i; found = true; break; }
        }
        if (!found) {
            var opt = el('option', { value: String(val), textContent: String(val) });
            sel.appendChild(opt);
            sel.value = String(val);
        }
    }

    // ── Similarity grouping ──
    // Computes a compact fingerprint per sprite and groups similar ones
    function spriteFingerprint(s) {
        if (!sheetData) return null;
        var w = sheetImg.width;
        // 1) Size bucket
        var sizeKey = s.w + 'x' + s.h;
        // 2) Color histogram (NES palette keys, 8-bin)
        var hist = {};
        var count = 0;
        for (var y = s.y; y < s.y + s.h; y++) {
            for (var x = s.x; x < s.x + s.w; x++) {
                var idx = (y * w + x) * 4;
                if (isBgPixel(idx)) continue;
                var k = A.nearestPalKey(sheetData.data[idx], sheetData.data[idx + 1], sheetData.data[idx + 2]);
                hist[k] = (hist[k] || 0) + 1;
                count++;
            }
        }
        // 3) Shape: divide into 4x4 zones, compute fill ratio per zone
        var zones = [];
        var zw = s.w / 4, zh = s.h / 4;
        for (var zy = 0; zy < 4; zy++) {
            for (var zx = 0; zx < 4; zx++) {
                var filled = 0, total = 0;
                for (var py = Math.floor(s.y + zy * zh); py < Math.floor(s.y + (zy + 1) * zh); py++) {
                    for (var px = Math.floor(s.x + zx * zw); px < Math.floor(s.x + (zx + 1) * zw); px++) {
                        total++;
                        var idx = (py * w + px) * 4;
                        if (!isBgPixel(idx)) filled++;
                    }
                }
                zones.push(total > 0 ? filled / total : 0);
            }
        }
        // Top 3 colors (sorted by frequency)
        var topColors = Object.keys(hist).sort(function (a, b) { return hist[b] - hist[a]; }).slice(0, 3).join('');
        return { sizeKey: sizeKey, topColors: topColors, zones: zones, pixelCount: count, hist: hist };
    }

    function fingerprintDistance(a, b) {
        if (!a || !b) return 999;
        // Size must match
        if (a.sizeKey !== b.sizeKey) return 100;
        // Zone shape distance (MSE)
        var zoneDist = 0;
        for (var i = 0; i < 16; i++) {
            var d = a.zones[i] - b.zones[i];
            zoneDist += d * d;
        }
        zoneDist = Math.sqrt(zoneDist / 16);
        // Color similarity
        var colorScore = (a.topColors === b.topColors) ? 0 : 0.3;
        // Pixel count similarity
        var maxPx = Math.max(a.pixelCount, b.pixelCount, 1);
        var pxDist = Math.abs(a.pixelCount - b.pixelCount) / maxPx;
        return zoneDist + colorScore + pxDist * 0.5;
    }

    function groupSimilar() {
        if (selections.length < 2) { alert('Need at least 2 detected sprites to group.'); return; }
        status('Computing similarity...');

        var fps = selections.map(function (s) { return spriteFingerprint(s); });

        // Greedy single-linkage clustering
        var threshold = 0.6;
        var groupId = new Array(selections.length);
        for (var i = 0; i < groupId.length; i++) groupId[i] = -1;
        var nextGroup = 0;

        for (var i = 0; i < selections.length; i++) {
            if (groupId[i] >= 0) continue;
            groupId[i] = nextGroup;
            for (var j = i + 1; j < selections.length; j++) {
                if (groupId[j] >= 0) continue;
                if (fingerprintDistance(fps[i], fps[j]) < threshold) {
                    groupId[j] = nextGroup;
                }
            }
            nextGroup++;
        }

        // Count per group
        var groupCounts = {};
        for (var i = 0; i < groupId.length; i++) {
            var g = groupId[i];
            groupCounts[g] = (groupCounts[g] || 0) + 1;
        }

        // Generate group base names from size + top colors of first member
        var groupNames = {};
        var sizeCounters = {};
        for (var g = 0; g < nextGroup; g++) {
            // Find first member
            var firstIdx = -1;
            for (var i = 0; i < groupId.length; i++) { if (groupId[i] === g) { firstIdx = i; break; } }
            if (firstIdx < 0 || !fps[firstIdx]) { groupNames[g] = 'sprite'; continue; }
            var fp = fps[firstIdx];
            var sizeTag = fp.sizeKey;
            if (!sizeCounters[sizeTag]) sizeCounters[sizeTag] = 0;
            sizeCounters[sizeTag]++;
            if (groupCounts[g] > 1) {
                groupNames[g] = sizeTag + '_set' + sizeCounters[sizeTag];
            } else {
                groupNames[g] = 'sprite_' + selections[firstIdx].x + '_' + selections[firstIdx].y;
            }
        }

        // Assign names and group tags
        var frameIdx = {};
        for (var i = 0; i < selections.length; i++) {
            var g = groupId[i];
            selections[i].group = g;
            if (groupCounts[g] > 1) {
                if (frameIdx[g] === undefined) frameIdx[g] = 0;
                selections[i].name = groupNames[g] + '_f' + frameIdx[g];
                frameIdx[g]++;
            }
        }

        // Sort: by group, then spatial order within group
        selections.sort(function (a, b) {
            if (a.group !== b.group) return a.group - b.group;
            if (a.y !== b.y) return a.y - b.y;
            return a.x - b.x;
        });

        activeSelIdx = -1;
        renderSheet();
        renderSpriteList();

        var multiGroups = 0;
        for (var g in groupCounts) { if (groupCounts[g] > 1) multiGroups++; }
        status('Found ' + nextGroup + ' groups (' + multiGroups + ' with multiple frames)');
    }

    // ── Grid select all ──
    function gridSelectAll() {
        if (!sheetImg || !sheetData) { alert('Load a sheet first.'); return; }
        var gw = parseInt(document.getElementById('ripGridW').value) || 16;
        var gh = parseInt(document.getElementById('ripGridH').value) || 16;

        selections = [];
        for (var cy = 0; cy + gh <= sheetImg.height; cy += gh) {
            for (var cx = 0; cx + gw <= sheetImg.width; cx += gw) {
                // Check if this cell has any non-bg content
                var hasContent = false;
                for (var py = cy; py < cy + gh && !hasContent; py++) {
                    for (var px = cx; px < cx + gw && !hasContent; px++) {
                        var idx = (py * sheetImg.width + px) * 4;
                        if (!isBgPixel(idx)) hasContent = true;
                    }
                }
                if (hasContent) {
                    var trimmed = trimToBounds(cx, cy, gw, gh);
                    if (trimmed.w >= 2 && trimmed.h >= 2) {
                        selections.push({
                            x: cx, y: cy, w: gw, h: gh,
                            name: 'sprite_' + cx + '_' + cy + '_' + gw + 'x' + gh
                        });
                    }
                }
            }
        }
        renderSheet();
        renderSpriteList();
        status('Grid: found ' + selections.length + ' non-empty cells');
    }

    // ── Sprite list ──
    // Color cycle for group indicators
    var GROUP_COLORS = ['#4ade80','#fbbf24','#60a5fa','#f472b6','#a78bfa','#fb923c','#34d399','#f87171','#38bdf8','#e879f9'];

    function renderSpriteList() {
        spriteListEl.innerHTML = '';
        var lastGroup = undefined;
        selections.forEach(function (s, i) {
            // Group divider
            if (s.group !== undefined && s.group !== lastGroup) {
                lastGroup = s.group;
                var groupColor = GROUP_COLORS[s.group % GROUP_COLORS.length];
                var divider = el('div', { style: {
                    padding: '2px 6px', fontSize: '9px', fontWeight: '600',
                    color: groupColor, borderTop: '2px solid ' + groupColor,
                    background: 'rgba(255,255,255,0.03)', marginTop: i > 0 ? '4px' : '0'
                }, textContent: 'Group ' + s.group + ' (' + s.w + '×' + s.h + ')' });
                spriteListEl.appendChild(divider);
            }

            var row = el('div', { style: {
                display: 'flex', gap: '4px', alignItems: 'center', padding: '3px 4px',
                borderBottom: '1px solid var(--border)', cursor: 'pointer'
            }});
            // Group color pip
            if (s.group !== undefined) {
                var gc = GROUP_COLORS[s.group % GROUP_COLORS.length];
                row.appendChild(el('div', { style: { width: '3px', height: '24px', background: gc, flexShrink: '0', borderRadius: '2px' } }));
            }
            // Mini preview
            var mini = el('canvas', { style: { width: '32px', height: '32px', imageRendering: 'pixelated', border: '1px solid var(--border)', flexShrink: '0' } });
            renderMiniPreview(mini, s);
            row.appendChild(mini);

            var nameInp = el('input', { type: 'text', value: s.name, style: { flex: '1', fontSize: '10px', minWidth: '0' } });
            nameInp.addEventListener('change', function () { s.name = this.value; renderSheet(); });
            row.appendChild(nameInp);

            row.appendChild(el('span', { style: { fontSize: '9px', color: 'var(--muted)', whiteSpace: 'nowrap' }, textContent: s.w + '×' + s.h }));

            var delBtn = el('button', { className: 'btn small', textContent: '×', style: { padding: '2px 6px' }, onClick: function (e) {
                e.stopPropagation();
                selections.splice(i, 1);
                if (activeSelIdx === i) activeSelIdx = -1;
                else if (activeSelIdx > i) activeSelIdx--;
                renderSheet();
                renderSpriteList();
            }});
            row.appendChild(delBtn);

            row.addEventListener('click', function () { activeSelIdx = i; previewSprite(i); renderSheet(); renderSpriteList(); });
            if (i === activeSelIdx) { row.style.background = 'rgba(100,170,255,0.15)'; }
            spriteListEl.appendChild(row);
        });
    }

    function renderMiniPreview(canvas, s) {
        if (!sheetData) return;
        var scale = Math.max(1, Math.floor(32 / Math.max(s.w, s.h)));
        canvas.width = s.w * scale; canvas.height = s.h * scale;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        // Draw from sheet image
        ctx.drawImage(sheetImg, s.x, s.y, s.w, s.h, 0, 0, s.w * scale, s.h * scale);
    }

    function previewSprite(idx) {
        if (idx < 0 || idx >= selections.length) return;
        var s = selections[idx];
        var pat = extractPattern(s);
        if (!pat) return;
        var scale = Math.max(1, Math.floor(200 / Math.max(s.w, s.h)));
        previewCanvas.width = s.w * scale;
        previewCanvas.height = s.h * scale;
        previewCtx.fillStyle = '#000';
        previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
        A.renderPattern(previewCtx, pat, 0, 0, scale);
    }

    // ── Extraction ──
    function extractPattern(s) {
        if (!sheetData) return null;
        var rows = [];
        for (var y = s.y; y < s.y + s.h; y++) {
            var row = '';
            for (var x = s.x; x < s.x + s.w; x++) {
                if (x < 0 || y < 0 || x >= sheetImg.width || y >= sheetImg.height) {
                    row += '_';
                    continue;
                }
                var idx = (y * sheetImg.width + x) * 4;
                if (isBgPixel(idx)) {
                    row += '_';
                } else {
                    row += A.nearestPalKey(sheetData.data[idx], sheetData.data[idx + 1], sheetData.data[idx + 2]);
                }
            }
            rows.push(row);
        }
        return rows;
    }

    function extractAll() {
        if (selections.length === 0) { alert('No sprites selected. Click+drag on the sheet or use Auto-Detect.'); return; }
        PATTERNS = getPatterns();
        var count = 0;
        selections.forEach(function (s) {
            var pat = extractPattern(s);
            if (pat) {
                PATTERNS[s.name] = pat;
                count++;
            }
        });
        A.scheduleSave();
        status('Extracted ' + count + ' sprites to pattern library');
    }

    function exportJSON() {
        if (selections.length === 0) { alert('No sprites selected.'); return; }
        var out = {};
        selections.forEach(function (s) {
            var pat = extractPattern(s);
            if (pat) out[s.name] = pat;
        });
        A.downloadJSON(out, 'extracted_sprites.json');
        status('Exported ' + Object.keys(out).length + ' sprites');
    }

    function clearSelections() {
        selections = [];
        renderSheet();
        renderSpriteList();
        status('Selections cleared');
    }

    function copyActiveCoords() {
        if (activeSelIdx < 0 || activeSelIdx >= selections.length) { alert('No active selection'); return; }
        var s = selections[activeSelIdx];
        var text = 'x: ' + s.x + ', y: ' + s.y + ', w: ' + s.w + ', h: ' + s.h;
        navigator.clipboard.writeText(text).then(function () {
            status('Copied: ' + text);
        });
    }

    function downloadActivePNG() {
        if (activeSelIdx < 0 || activeSelIdx >= selections.length || !sheetImg) { alert('No active selection'); return; }
        var s = selections[activeSelIdx];
        var tmp = document.createElement('canvas');
        tmp.width = s.w; tmp.height = s.h;
        var tc = tmp.getContext('2d');
        tc.drawImage(sheetImg, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
        var link = document.createElement('a');
        link.download = s.name + '.png';
        link.href = tmp.toDataURL('image/png');
        link.click();
        status('Downloaded: ' + s.name + '.png');
    }

    // Keyboard shortcuts (only when ripper tab is active)
    document.addEventListener('keydown', function (e) {
        // Only handle when ripper tab panel is visible
        var panel = document.getElementById('tab-ripper');
        if (!panel || !panel.classList.contains('active')) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

        // +/= zoom in, - zoom out, 0 reset zoom
        if (e.key === '+' || e.key === '=') { zoom = Math.min(10, zoom + 1); var zSel = document.getElementById('ripZoomSel'); if (zSel) zSel.value = String(zoom); renderSheet(); return; }
        if (e.key === '-') { zoom = Math.max(1, zoom - 1); var zSel = document.getElementById('ripZoomSel'); if (zSel) zSel.value = String(zoom); renderSheet(); return; }
        if (e.key === '0') { zoom = 3; var zSel = document.getElementById('ripZoomSel'); if (zSel) zSel.value = String(zoom); renderSheet(); return; }
        if (e.key === 'Escape') { activeSelIdx = -1; renderSheet(); renderSpriteList(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (activeSelIdx >= 0 && activeSelIdx < selections.length) {
                selections.splice(activeSelIdx, 1);
                activeSelIdx = Math.min(activeSelIdx, selections.length - 1);
                renderSheet(); renderSpriteList();
            }
            return;
        }

        // Arrow keys nudge active selection
        if (activeSelIdx >= 0 && activeSelIdx < selections.length) {
            var step = e.shiftKey ? 10 : 1;
            var s = selections[activeSelIdx];
            if (e.key === 'ArrowUp') { e.preventDefault(); s.y = Math.max(0, s.y - step); renderSheet(); previewSprite(activeSelIdx); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); s.y = Math.min((sheetImg ? sheetImg.height : 9999) - s.h, s.y + step); renderSheet(); previewSprite(activeSelIdx); return; }
            if (e.key === 'ArrowLeft') { e.preventDefault(); s.x = Math.max(0, s.x - step); renderSheet(); previewSprite(activeSelIdx); return; }
            if (e.key === 'ArrowRight') { e.preventDefault(); s.x = Math.min((sheetImg ? sheetImg.width : 9999) - s.w, s.x + step); renderSheet(); previewSprite(activeSelIdx); return; }
        }

        // Ctrl+C = copy coords
        if (e.ctrlKey && e.key === 'c') { e.preventDefault(); copyActiveCoords(); return; }
        // Ctrl+S = download png
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); downloadActivePNG(); return; }
    });

    function status(msg) {
        if (statusEl) statusEl.textContent = msg;
    }

    A.registerTab('ripper', init, function () { renderSheet(); });
})();
