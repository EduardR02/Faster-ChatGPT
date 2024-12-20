function populateDummyHistory() {
    const topics = ['AI Discussion', 'Gaming Session', 'Code Review', 'Movie Analysis', 'Book Chat', 'Project Planning', 'Debug Help', 'Random Thoughts'];
    const times = ['AM', 'PM'];
    const container = document.querySelector('.history-list');

    for (let i = 0; i < 100; i++) {
        const hour = Math.floor(Math.random() * 12) + 1;
        const minute = String(Math.floor(Math.random() * 60)).padStart(2, '0');
        const ampm = times[Math.floor(Math.random() * 2)];
        
        const div = document.createElement('div');
        div.className = 'history-sidebar-item';
        div.textContent = `${topics[Math.floor(Math.random() * topics.length)]} ${hour}:${minute} ${ampm}`;
        
        container.appendChild(div);
    }
}

// Run it when page loads
document.addEventListener('DOMContentLoaded', populateDummyHistory);