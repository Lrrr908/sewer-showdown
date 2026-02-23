/* ================================================================
   admin-artists.js — Artist & Building Manager Tab
   CRUD interface for artist and building data
   ================================================================ */

(function () {
    'use strict';
    var A = Admin;
    var el = A.el;

    var sortKey = 'name', sortDir = 1;
    var filterText = '';
    var selectedArtistId = null;
    var selectedBuildingId = null;
    var activeSubTab = 'artists'; // 'artists' or 'buildings'

    // DOM refs
    var tableBody, editorPanel, buildingTableBody, buildingEditor, statusEl, mapPreviewCanvas;

    function init() {
        var panel = document.getElementById('tab-artists');
        panel.innerHTML = '';
        panel.style.cssText = 'flex-direction:column;';

        // Sub-tab bar
        var subBar = el('div', { style: { display: 'flex', gap: '0', borderBottom: '1px solid var(--border)', background: 'var(--surface)' } });
        ['artists', 'buildings'].forEach(function (id) {
            var btn = el('button', {
                className: 'tab-btn' + (id === activeSubTab ? ' active' : ''),
                textContent: id === 'artists' ? 'Artists' : 'Buildings',
                'data-subtab': id
            });
            btn.addEventListener('click', function () {
                activeSubTab = id;
                subBar.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.subtab === id); });
                artistsView.style.display = id === 'artists' ? 'flex' : 'none';
                buildingsView.style.display = id === 'buildings' ? 'flex' : 'none';
            });
            subBar.appendChild(btn);
        });
        panel.appendChild(subBar);

        // Artists view
        var artistsView = el('div', { id: 'artistsView', style: { display: activeSubTab === 'artists' ? 'flex' : 'none', flex: '1', overflow: 'hidden' } });
        buildArtistsView(artistsView);

        // Buildings view
        var buildingsView = el('div', { id: 'buildingsView', style: { display: activeSubTab === 'buildings' ? 'flex' : 'none', flex: '1', overflow: 'hidden' } });
        buildBuildingsView(buildingsView);

        panel.appendChild(artistsView);
        panel.appendChild(buildingsView);

        // Status bar
        var statusBar = el('div', { style: { padding: '4px 10px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', gap: '8px', alignItems: 'center' } });
        statusBar.appendChild(el('button', { className: 'btn small success', textContent: 'Export Artists JSON', onClick: function () {
            A.downloadJSON({ artists: A.data.artists }, 'artists.json');
        }}));
        statusBar.appendChild(el('button', { className: 'btn small success', textContent: 'Export Buildings JSON', onClick: function () {
            A.downloadJSON({ buildings: A.data.buildings }, 'buildings.json');
        }}));
        statusBar.appendChild(el('button', { className: 'btn small', textContent: 'Import CSV', onClick: importCSV }));
        statusEl = el('div', { className: 'status-msg', style: { flex: '1' } });
        statusBar.appendChild(statusEl);
        panel.appendChild(statusBar);
    }

    // ── Artists view ──
    function buildArtistsView(container) {
        // Left: table
        var left = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' } });

        var toolbar = el('div', { style: { padding: '8px', display: 'flex', gap: '8px', alignItems: 'center', borderBottom: '1px solid var(--border)' } });
        var searchInput = el('input', { type: 'text', placeholder: 'Filter by name/city...', style: { flex: '1', maxWidth: '300px' } });
        searchInput.addEventListener('input', function () { filterText = this.value; renderArtistTable(); });
        toolbar.appendChild(searchInput);
        toolbar.appendChild(el('button', { className: 'btn small success', textContent: '+ Add Artist', onClick: addArtist }));
        toolbar.appendChild(el('span', { id: 'artistCount', style: { fontSize: '11px', color: 'var(--muted)' } }));
        left.appendChild(toolbar);

        var tableWrap = el('div', { style: { flex: '1', overflow: 'auto' } });
        var table = el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } });

        var thead = el('thead');
        var headerRow = el('tr', { style: { background: 'var(--surface)', position: 'sticky', top: '0', zIndex: '1' } });
        var columns = [
            { key: 'name', label: 'Name' },
            { key: 'city', label: 'City' },
            { key: 'country', label: 'Country' },
            { key: 'regionId', label: 'Region' },
            { key: 'instagram', label: 'Instagram' }
        ];
        columns.forEach(function (col) {
            var th = el('th', {
                style: { padding: '6px 8px', textAlign: 'left', cursor: 'pointer', borderBottom: '1px solid var(--border)', color: 'var(--muted)', userSelect: 'none', whiteSpace: 'nowrap' },
                textContent: col.label + (sortKey === col.key ? (sortDir === 1 ? ' ▲' : ' ▼') : '')
            });
            th.addEventListener('click', function () {
                if (sortKey === col.key) sortDir *= -1;
                else { sortKey = col.key; sortDir = 1; }
                renderArtistTable();
            });
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
        tableBody = el('tbody');
        table.appendChild(tableBody);
        tableWrap.appendChild(table);
        left.appendChild(tableWrap);

        // Right: editor + map
        var right = el('div', { style: { width: '320px', minWidth: '300px', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflowY: 'auto', background: 'var(--surface)' } });
        editorPanel = el('div', { style: { padding: '10px' } });
        editorPanel.appendChild(el('div', { style: { color: 'var(--muted)', fontSize: '11px' }, textContent: 'Select an artist to edit' }));
        right.appendChild(editorPanel);

        right.appendChild(el('hr'));
        right.appendChild(el('div', { className: 'panel-title', style: { padding: '0 10px' }, textContent: 'Map Preview' }));
        mapPreviewCanvas = el('canvas', { width: '280', height: '180', style: { margin: '8px 10px', border: '1px solid var(--border)', background: '#0a0b10' } });
        right.appendChild(mapPreviewCanvas);

        container.appendChild(left);
        container.appendChild(right);

        renderArtistTable();
    }

    function renderArtistTable() {
        if (!tableBody) return;
        tableBody.innerHTML = '';
        var artists = A.data.artists || [];
        var filtered = artists.filter(function (a) {
            if (!filterText) return true;
            var t = filterText.toLowerCase();
            return (a.name || '').toLowerCase().indexOf(t) >= 0 ||
                   (a.city || '').toLowerCase().indexOf(t) >= 0 ||
                   (a.country || '').toLowerCase().indexOf(t) >= 0 ||
                   (a.id || '').toLowerCase().indexOf(t) >= 0;
        });
        filtered.sort(function (a, b) {
            var va = (a[sortKey] || '').toString().toLowerCase();
            var vb = (b[sortKey] || '').toString().toLowerCase();
            return va < vb ? -sortDir : va > vb ? sortDir : 0;
        });

        var countEl = document.getElementById('artistCount');
        if (countEl) countEl.textContent = filtered.length + ' / ' + artists.length + ' artists';

        filtered.forEach(function (artist) {
            var tr = el('tr', {
                style: {
                    cursor: 'pointer',
                    background: artist.id === selectedArtistId ? 'var(--surface2)' : 'transparent'
                }
            });
            tr.addEventListener('click', function () {
                selectedArtistId = artist.id;
                renderArtistTable();
                renderArtistEditor(artist);
                renderMapPreview(artist);
            });
            tr.addEventListener('mouseenter', function () { if (artist.id !== selectedArtistId) tr.style.background = 'rgba(106,169,255,0.05)'; });
            tr.addEventListener('mouseleave', function () { if (artist.id !== selectedArtistId) tr.style.background = 'transparent'; });

            [artist.name, artist.city, artist.country, artist.regionId, artist.instagram ? '✓' : ''].forEach(function (val) {
                tr.appendChild(el('td', {
                    style: { padding: '5px 8px', borderBottom: '1px solid var(--border)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    textContent: val || ''
                }));
            });
            tableBody.appendChild(tr);
        });
    }

    function renderArtistEditor(artist) {
        editorPanel.innerHTML = '';
        editorPanel.appendChild(el('div', { className: 'panel-title', textContent: 'Edit Artist' }));

        var fields = [
            { key: 'id', label: 'ID', type: 'text', readonly: true },
            { key: 'name', label: 'Name', type: 'text' },
            { key: 'bio', label: 'Bio', type: 'textarea' },
            { key: 'instagram', label: 'Instagram URL', type: 'text' },
            { key: 'city', label: 'City', type: 'text' },
            { key: 'country', label: 'Country', type: 'text' },
            { key: 'regionId', label: 'Region ID', type: 'text' },
            { key: 'regionIdOverride', label: 'Region Override', type: 'text' },
            { key: 'lat', label: 'Latitude', type: 'number' },
            { key: 'lon', label: 'Longitude', type: 'number' }
        ];

        fields.forEach(function (f) {
            var wrap = el('div', { style: { marginBottom: '6px' } });
            wrap.appendChild(el('label', { textContent: f.label }));
            var inp;
            if (f.type === 'textarea') {
                inp = el('textarea', { rows: '3', style: { width: '100%', resize: 'vertical' } });
                inp.value = artist[f.key] || '';
            } else {
                inp = el('input', { type: f.type, style: { width: '100%' } });
                inp.value = artist[f.key] != null ? artist[f.key] : '';
            }
            if (f.readonly) inp.readOnly = true;
            inp.addEventListener('change', function () {
                var val = f.type === 'number' ? parseFloat(this.value) : this.value;
                artist[f.key] = val;
                renderArtistTable();
                A.scheduleSave();
                status('Updated ' + artist.name + '.' + f.key);
            });
            wrap.appendChild(inp);
            editorPanel.appendChild(wrap);
        });

        // Images list
        editorPanel.appendChild(el('label', { textContent: 'Images' }));
        var imgList = el('div', { style: { fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' } });
        (artist.images || []).forEach(function (url, i) {
            var row = el('div', { className: 'row', style: { marginBottom: '2px' } });
            row.appendChild(el('input', { type: 'text', value: url, style: { flex: '1', fontSize: '11px' }, onChange: function () { artist.images[i] = this.value; } }));
            row.appendChild(el('button', { className: 'btn small danger', textContent: '×', onClick: function () {
                artist.images.splice(i, 1);
                renderArtistEditor(artist);
            }}));
            imgList.appendChild(row);
        });
        editorPanel.appendChild(imgList);
        editorPanel.appendChild(el('button', { className: 'btn small', textContent: '+ Add Image URL', onClick: function () {
            if (!artist.images) artist.images = [];
            artist.images.push('');
            renderArtistEditor(artist);
        }}));

        editorPanel.appendChild(el('hr'));
        editorPanel.appendChild(el('button', { className: 'btn small danger', textContent: 'Delete Artist', onClick: function () {
            if (!confirm('Delete "' + artist.name + '"?')) return;
            var idx = A.data.artists.indexOf(artist);
            if (idx >= 0) A.data.artists.splice(idx, 1);
            selectedArtistId = null;
            renderArtistTable();
            editorPanel.innerHTML = '';
            editorPanel.appendChild(el('div', { style: { color: 'var(--muted)', fontSize: '11px' }, textContent: 'Deleted' }));
            A.scheduleSave();
        }}));
    }

    function addArtist() {
        var name = prompt('Artist name:');
        if (!name) return;
        var id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        var artist = {
            id: id, name: name.toUpperCase(), bio: '', instagram: '',
            images: [], regionId: 'na', regionIdOverride: null,
            lat: 0, lon: 0, city: '', country: ''
        };
        A.data.artists.push(artist);
        selectedArtistId = id;
        renderArtistTable();
        renderArtistEditor(artist);
        A.scheduleSave();
        status('Added: ' + name);
    }

    function renderMapPreview(artist) {
        if (!mapPreviewCanvas || !artist) return;
        var ctx = mapPreviewCanvas.getContext('2d');
        var w = mapPreviewCanvas.width, h = mapPreviewCanvas.height;
        ctx.fillStyle = '#0070ec';
        ctx.fillRect(0, 0, w, h);

        // Simple world rectangle
        ctx.fillStyle = '#00a800';
        ctx.fillRect(10, 20, w - 20, h - 40);

        // Plot this artist
        if (artist.lat && artist.lon) {
            var px = ((artist.lon + 180) / 360) * (w - 20) + 10;
            var py = ((90 - artist.lat) / 180) * (h - 40) + 20;
            ctx.fillStyle = '#fcfc00';
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = '9px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText(artist.name, px, py - 8);
        }

        // Plot all other artists as dots
        ctx.fillStyle = 'rgba(252,252,252,0.3)';
        (A.data.artists || []).forEach(function (a) {
            if (a.id === artist.id || !a.lat || !a.lon) return;
            var ax = ((a.lon + 180) / 360) * (w - 20) + 10;
            var ay = ((90 - a.lat) / 180) * (h - 40) + 20;
            ctx.fillRect(ax - 1, ay - 1, 2, 2);
        });
    }

    // ── Buildings view ──
    function buildBuildingsView(container) {
        var left = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' } });

        var toolbar = el('div', { style: { padding: '8px', display: 'flex', gap: '8px', alignItems: 'center', borderBottom: '1px solid var(--border)' } });
        toolbar.appendChild(el('button', { className: 'btn small success', textContent: '+ Add Building', onClick: addBuilding }));
        toolbar.appendChild(el('span', { id: 'buildingCount', style: { fontSize: '11px', color: 'var(--muted)' } }));
        left.appendChild(toolbar);

        var tableWrap = el('div', { style: { flex: '1', overflow: 'auto' } });
        var table = el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } });
        var thead = el('thead');
        var headerRow = el('tr', { style: { background: 'var(--surface)', position: 'sticky', top: '0', zIndex: '1' } });
        ['ID', 'Artist', 'Type', 'Priority'].forEach(function (label) {
            headerRow.appendChild(el('th', { style: { padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid var(--border)', color: 'var(--muted)' }, textContent: label }));
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
        buildingTableBody = el('tbody');
        table.appendChild(buildingTableBody);
        tableWrap.appendChild(table);
        left.appendChild(tableWrap);

        // Right: building editor
        var right = el('div', { style: { width: '300px', minWidth: '280px', borderLeft: '1px solid var(--border)', overflowY: 'auto', background: 'var(--surface)' } });
        buildingEditor = el('div', { style: { padding: '10px' } });
        buildingEditor.appendChild(el('div', { style: { color: 'var(--muted)', fontSize: '11px' }, textContent: 'Select a building to edit' }));
        right.appendChild(buildingEditor);

        container.appendChild(left);
        container.appendChild(right);

        renderBuildingTable();
    }

    function renderBuildingTable() {
        if (!buildingTableBody) return;
        buildingTableBody.innerHTML = '';
        var buildings = A.data.buildings || [];

        var countEl = document.getElementById('buildingCount');
        if (countEl) countEl.textContent = buildings.length + ' buildings';

        buildings.forEach(function (b) {
            var tr = el('tr', {
                style: {
                    cursor: 'pointer',
                    background: b.id === selectedBuildingId ? 'var(--surface2)' : 'transparent'
                }
            });
            tr.addEventListener('click', function () {
                selectedBuildingId = b.id;
                renderBuildingTable();
                renderBuildingEditor(b);
            });
            tr.addEventListener('mouseenter', function () { if (b.id !== selectedBuildingId) tr.style.background = 'rgba(106,169,255,0.05)'; });
            tr.addEventListener('mouseleave', function () { if (b.id !== selectedBuildingId) tr.style.background = 'transparent'; });

            var artistName = '';
            if (b.artistId) {
                var a = (A.data.artists || []).find(function (a) { return a.id === b.artistId; });
                if (a) artistName = a.name;
            }

            [b.id, artistName || b.artistId || '-', b.buildingType || 'gallery', b.priority || 0].forEach(function (val) {
                tr.appendChild(el('td', {
                    style: { padding: '5px 8px', borderBottom: '1px solid var(--border)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    textContent: String(val)
                }));
            });
            buildingTableBody.appendChild(tr);
        });
    }

    function renderBuildingEditor(building) {
        buildingEditor.innerHTML = '';
        buildingEditor.appendChild(el('div', { className: 'panel-title', textContent: 'Edit Building' }));

        var idWrap = el('div', { style: { marginBottom: '6px' } });
        idWrap.appendChild(el('label', { textContent: 'ID' }));
        idWrap.appendChild(el('input', { type: 'text', value: building.id, readOnly: true, style: { width: '100%' } }));
        buildingEditor.appendChild(idWrap);

        // Building type
        var typeWrap = el('div', { style: { marginBottom: '6px' } });
        typeWrap.appendChild(el('label', { textContent: 'Building Type' }));
        var typeSel = el('select', { style: { width: '100%' } });
        ['gallery', 'arcade', 'warehouse', 'diner', 'hotel', 'garage', 'toyshop', 'dimension_x'].forEach(function (t) {
            var opt = el('option', { value: t, textContent: t });
            if (t === building.buildingType) opt.selected = true;
            typeSel.appendChild(opt);
        });
        typeSel.addEventListener('change', function () {
            building.buildingType = this.value;
            renderBuildingTable();
            A.scheduleSave();
            status('Updated building type');
        });
        typeWrap.appendChild(typeSel);
        buildingEditor.appendChild(typeWrap);

        // Artist assignment
        var artistWrap = el('div', { style: { marginBottom: '6px' } });
        artistWrap.appendChild(el('label', { textContent: 'Assigned Artist' }));
        var artistSel = el('select', { style: { width: '100%' } });
        artistSel.appendChild(el('option', { value: '', textContent: '(none)' }));
        (A.data.artists || []).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (a) {
            var opt = el('option', { value: a.id, textContent: a.name + ' (' + a.id + ')' });
            if (a.id === building.artistId) opt.selected = true;
            artistSel.appendChild(opt);
        });
        artistSel.addEventListener('change', function () {
            building.artistId = this.value || null;
            renderBuildingTable();
            A.scheduleSave();
            status('Updated artist assignment');
        });
        artistWrap.appendChild(artistSel);
        buildingEditor.appendChild(artistWrap);

        // Priority
        var priWrap = el('div', { style: { marginBottom: '6px' } });
        priWrap.appendChild(el('label', { textContent: 'Priority' }));
        var priInp = el('input', { type: 'number', value: building.priority || 0, style: { width: '100%' } });
        priInp.addEventListener('change', function () { building.priority = parseInt(this.value) || 0; renderBuildingTable(); A.scheduleSave(); });
        priWrap.appendChild(priInp);
        buildingEditor.appendChild(priWrap);

        // Custom sign
        var signWrap = el('div', { style: { marginBottom: '6px' } });
        signWrap.appendChild(el('label', { textContent: 'Custom Sign Text' }));
        var signInp = el('input', { type: 'text', value: building.customSign || '', style: { width: '100%' } });
        signInp.addEventListener('change', function () { building.customSign = this.value; });
        signWrap.appendChild(signInp);
        buildingEditor.appendChild(signWrap);

        buildingEditor.appendChild(el('hr'));
        buildingEditor.appendChild(el('button', { className: 'btn small danger', textContent: 'Delete Building', onClick: function () {
            if (!confirm('Delete building "' + building.id + '"?')) return;
            var idx = A.data.buildings.indexOf(building);
            if (idx >= 0) A.data.buildings.splice(idx, 1);
            selectedBuildingId = null;
            renderBuildingTable();
            buildingEditor.innerHTML = '';
            A.scheduleSave();
            status('Deleted building');
        }}));
    }

    function addBuilding() {
        var id = prompt('Building ID (e.g. b_my_building):');
        if (!id) return;
        var building = { id: id, artistId: null, buildingType: 'gallery', priority: 0 };
        A.data.buildings.push(building);
        selectedBuildingId = id;
        renderBuildingTable();
        renderBuildingEditor(building);
        A.scheduleSave();
        status('Added building: ' + id);
    }

    // ── CSV import ──
    async function importCSV() {
        var file = await A.promptFile('.csv');
        if (!file) return;
        var text = await A.readFileAsText(file);
        var lines = text.trim().split('\n');
        if (lines.length < 2) { status('CSV too short'); return; }

        var headers = lines[0].split(',').map(function (h) { return h.trim().toLowerCase(); });
        var count = 0;
        for (var i = 1; i < lines.length; i++) {
            var vals = lines[i].split(',');
            var obj = {};
            headers.forEach(function (h, idx) { obj[h] = (vals[idx] || '').trim(); });

            var name = obj.name || obj.artist || '';
            if (!name) continue;
            var id = (obj.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '_');

            var existing = A.data.artists.find(function (a) { return a.id === id; });
            if (existing) {
                if (obj.city) existing.city = obj.city;
                if (obj.country) existing.country = obj.country;
                if (obj.instagram) existing.instagram = obj.instagram;
                if (obj.lat) existing.lat = parseFloat(obj.lat);
                if (obj.lon) existing.lon = parseFloat(obj.lon);
            } else {
                A.data.artists.push({
                    id: id, name: name.toUpperCase(), bio: obj.bio || '',
                    instagram: obj.instagram || '', images: [],
                    regionId: obj.region || obj.regionid || 'na',
                    regionIdOverride: null,
                    lat: parseFloat(obj.lat) || 0,
                    lon: parseFloat(obj.lon) || 0,
                    city: obj.city || '', country: obj.country || ''
                });
            }
            count++;
        }
        renderArtistTable();
        A.scheduleSave();
        status('Imported ' + count + ' artists from CSV');
    }

    function status(msg) {
        if (statusEl) statusEl.textContent = msg;
    }

    A.registerTab('artists', init);
})();
