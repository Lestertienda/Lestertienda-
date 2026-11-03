// Estado global del usuario
let misFichas = 30; // Arrancamos con 30 fichas de prueba para que pruebes
let miSaldo = 1000;

document.addEventListener('DOMContentLoaded', () => {
    actualizarInterfaz();
});

function actualizarInterfaz() {
    document.getElementById('fichas-count').innerText = misFichas;
}

function abrirModalRecarga() {
    document.getElementById('modal-recarga').style.display = 'flex';
}

function cerrarModalRecarga() {
    document.getElementById('modal-recarga').style.display = 'none';
}

function comprarFichas(cantidad, costoSaldo, costoUsdt) {
    misFichas += cantidad;
    actualizarInterfaz();
    alert(`¡Has comprado ${cantidad} fichas exitosamente!`);
    cerrarModalRecarga();
}

function abrirPlataformas() {
    const section = document.getElementById('dynamic-section');
    const content = document.getElementById('dynamic-content');
    document.getElementById('dynamic-title').innerText = "Elige la plataforma";
    
    section.style.display = 'block';
    content.innerHTML = `
        <div class="platform-grid">
            <div class="platform-card whatsapp" onclick="mostrarPaisesWhatsApp()">
                <span class="p-icon">💚</span>
                <h3>WhatsApp</h3>
                <p>Números disponibles para verificación</p>
            </div>
            <div class="platform-card telegram" onclick="mostrarPaisesTelegram()">
                <span class="p-icon">💙</span>
                <h3>Telegram</h3>
                <p>Números disponibles para verificación</p>
            </div>
        </div>
    `;
    section.scrollIntoView({ behavior: 'smooth' });
}

function cerrarPlataformas() {
    document.getElementById('dynamic-section').style.display = 'none';
}

function mostrarPaisesWhatsApp() {
    document.getElementById('dynamic-title').innerText = "WhatsApp - Elige el País";
    const content = document.getElementById('dynamic-content');
    content.innerHTML = `
        <div class="country-grid">
            <div class="country-card" onclick="comprarNumero('WhatsApp', '+52 (México)', 70)">
                <h4>🇲🇽 México (+52)</h4>
                <p class="cost-tag">🪙 70 Fichas</p>
                <button class="btn-green">Obtener Número</button>
            </div>
            <div class="country-card" onclick="comprarNumero('WhatsApp', '+1 (USA)', 30)">
                <h4>🇺🇸 Estados Unidos (+1)</h4>
                <p class="cost-tag">🪙 30 Fichas</p>
                <button class="btn-green">Obtener Número</button>
            </div>
        </div>
        <button class="btn-back-sub" onclick="abrirPlataformas()">← Volver a plataformas</button>
    `;
}

function mostrarPaisesTelegram() {
    document.getElementById('dynamic-title').innerText = "Telegram - Elige el País";
    const content = document.getElementById('dynamic-content');
    content.innerHTML = `
        <div class="country-grid">
            <div class="country-card" onclick="comprarNumero('Telegram', '+1 (USA)', 15)">
                <h4>🇺🇸 Estados Unidos (+1)</h4>
                <p class="cost-tag">🪙 15 Fichas</p>
                <button class="btn-green">Obtener Número</button>
            </div>
        </div>
        <button class="btn-back-sub" onclick="abrirPlataformas()">← Volver a plataformas</button>
    `;
}

function comprarNumero(app, pais, costo) {
    if (misFichas < costo) {
        alert(`No tienes suficientes fichas. Necesitas ${costo} fichas y tienes ${misFichas}. Recarga fichas arriba.`);
        abrirModalRecarga();
        return;
    }

    misFichas -= costo;
    actualizarInterfaz();

    // Generar un número real simulado funcional para copiar
    let numeroReal = pais.includes('+52') ? "+52 55 " + Math.floor(1000 + Math.random() * 9000) + " " + Math.floor(1000 + Math.random() * 9000) : "+1 415 " + Math.floor(100 + Math.random() * 900) + " " + Math.floor(1000 + Math.random() * 9000);

    const content = document.getElementById('dynamic-content');
    document.getElementById('dynamic-title').innerText = `¡Número de ${app} Adquirido!`;
    content.innerHTML = `
        <div class="success-box">
            <p>Tu número para <b>${app} (${pais})</b> está listo:</p>
            <div class="phone-number-display">${numeroReal}</div>
            <p class="instruction-text">Cópialo y pégalo directamente en tu aplicación de ${app}. El código llegará aquí abajo.</p>
            <div class="sms-box">
                <span class="pulsing-dot"></span> Esperando código de verificación...
            </div>
            <button class="btn-green" onclick="abrirPlataformas()">Adquirir otro número</button>
        </div>
    `;
}

function verMisPedidos() {
    alert("No tienes números activos en este momento.");
}
