const toggleH4 = document.getElementById('toggle-h4-filter');
const toggleTrailing = document.getElementById('toggle-trailing-stop');
const toggleCE = document.getElementById('toggle-ce-entry');

async function fetchConfig() {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        toggleH4.checked = config.USE_H4_FILTER;
        toggleTrailing.checked = config.USE_TRAILING_STOP;
        toggleCE.checked = config.USE_CE_ENTRY;
    } catch(e) {
        console.error('Failed to load config', e);
    }
}

async function updateConfig(key, value) {
    try {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value })
        });
    } catch(e) {
        console.error('Failed to update config', e);
    }
}

toggleH4.addEventListener('change', (e) => {
    updateConfig('USE_H4_FILTER', e.target.checked);
});

toggleTrailing.addEventListener('change', (e) => {
    updateConfig('USE_TRAILING_STOP', e.target.checked);
});

toggleCE.addEventListener('change', (e) => {
    updateConfig('USE_CE_ENTRY', e.target.checked);
});

fetchConfig();
