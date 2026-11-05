// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* Writes the page (application.xml and uiDescription.json) from one list,
 * so the two always agree.  node tools/make_page.js <staged tree> */
'use strict';
const fs = require('fs');
const path = require('path');
const T = process.argv[2];
/* [id, type, widget, name, focusable, first text] */
const C = [
    [20, 'label', 'LT_Label_1Row', 'castStatus', 0, 'Connecting…'],
    [21, 'label', 'LT_Label_1Graphic_Scalable', 'castQr', 0, null],
    [22, 'label', 'LT_Label_1Row', 'castLink', 0, ''],
    [23, 'label', 'LT_Label_1Row', 'castHint', 0, 'Scan with the phone whose hotspot the car is on'],
    [35, 'button', 'LT_Button_1Row', 'castEnable', 3, 'Cast to cluster: on'],
    [30, 'button', 'LT_Button_1Row', 'castStop', 3, 'Stop'],
    [38, 'button', 'LT_Button_1Row', 'castCarplayOn', 3, 'CarPlay second screen: off'],
    [39, 'button', 'LT_Button_1Row', 'castCarplayDirections', 3, 'CarPlay directions card: on'],
    [43, 'button', 'LT_Button_1Row', 'castCarplayEta', 3, 'CarPlay time / distance card: on'],
    [44, 'button', 'LT_Button_1Row', 'castCarplayZoomIn', 3, 'CarPlay map: zoom in'],
    [45, 'button', 'LT_Button_1Row', 'castCarplayZoomOut', 3, 'CarPlay map: zoom out'],
    [41, 'button', 'LT_Button_1Row', 'castCarplayCentre', 3, 'CarPlay: centre the map: on'],
    [42, 'button', 'LT_Button_1Row', 'castCarplayHudAlt', 3, 'CarPlay HUD alternate mode: off'],
    [46, 'button', 'LT_Button_1Row', 'castCarplayViewAreas', 3, 'CarPlay view areas: on'],
    [36, 'button', 'LT_Button_1Row', 'castCarplayMap', 3, 'CarPlay map on the cluster'],
    [37, 'button', 'LT_Button_1Row', 'castCarplayHud', 3, 'CarPlay map on the HUD'],
    [31, 'button', 'LT_Button_1Row', 'castMap', 3, 'Play last on the cluster map'],
    [32, 'button', 'LT_Button_1Row', 'castHud', 3, 'Play last on the HUD'],
    [33, 'button', 'LT_Button_1Row', 'castConsole', 3, 'Play last on this screen'],
    [34, 'button', 'LT_Button_1Row', 'castQrToggle', 3, 'QR code on the cluster: off'],
    [40, 'label', 'LT_Label_1Row', 'castInfo', 0, ''],
];
const dir = path.join(T, 'rhmiData', 'uiDescriptions', 'ID7');
let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- SPDX-License-Identifier: GPL-3.0-or-later -->\n<!-- Copyright (C) 2026 Yousaf Khan -->\n<application>\n' +
    '    <container id="1" type="state" widget="LT_State_Wide">\n        <layoutGroup id="100" name="Titlebar">\n' +
    '            <component id="10" type="title">\n                <property id="2" value="1"/>\n            </component>\n        </layoutGroup>\n' +
    '        <layoutGroup id="200" name="List">\n            <property id="3" value="1"/>\n';
C.forEach(([id, type, widget, , focus]) => {
    xml += `            <component id="${id}" type="${type}" widget="${widget}">\n                <property id="2" value="1"/>\n                <property id="3" value="${focus}"/>\n            </component>\n`;
});
xml += '        </layoutGroup>\n    </container>\n</application>\n';
fs.writeFileSync(path.join(dir, 'application.xml'), xml);
const vis = { Visible: { value: 1, type: 'UInt' } };
const comps = { 10: { type: 'title', name: 'castTitle', properties: vis, rows: [{ Text: { value: 'SID_CAST_TITLE', type: 'StringId' } }] } };
C.forEach(([id, type, , name, focus, text]) => {
    comps[id] = { type: type, name: name, properties: Object.assign({}, vis, { Focusable: { value: focus, type: 'UInt' } }),
        rows: [text === null ? {} : { Text: { value: text, type: 'Text' } }] };
});
fs.writeFileSync(path.join(dir, 'uiDescription.json'),
    JSON.stringify({ schemaVersion: '1.3.0', containers: { 1: { type: 'state', name: 'ST_OnlineApps_VizualyseCast', components: comps } } }, null, 2) + '\n');
console.log('page: ' + C.length + ' rows');
