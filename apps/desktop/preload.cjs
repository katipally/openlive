"use strict";
// Minimal, locked-down preload. contextIsolation is on and we expose nothing —
// the UI is a normal web app talking to localhost, so it needs no Node bridge.
// This file exists so the renderer runs with a clean, isolated context.
