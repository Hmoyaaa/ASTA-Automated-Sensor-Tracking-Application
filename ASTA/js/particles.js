/**
 * ASTA (Automated Sensor Tracking Application)
 * particles.js - Motor de Partículas de Anti-Magia Carmesí y Negro Abisal
 * Basado en el aura roja y negra de Asta en Black Clover
 */

(function () {
    const canvas = document.getElementById('antimagic-particles');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const isMobile = window.innerWidth < 768;
    const PARTICLE_COUNT = isMobile ? 42 : 85;
    const particles = [];

    const mouse = {
        x: width / 2,
        y: height / 2,
        active: false
    };

    window.addEventListener('resize', () => {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
    });

    window.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouse.active = true;
    });

    window.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
            mouse.x = e.touches[0].clientX;
            mouse.y = e.touches[0].clientY;
            mouse.active = true;
        }
    }, { passive: true });

    class AntiMagicParticle {
        constructor(randomY = true) {
            this.reset(randomY);
        }

        reset(randomY = false) {
            this.x = Math.random() * width;
            this.y = randomY ? Math.random() * height : height + 20;
            this.size = Math.random() * 4.5 + 1.5;
            this.speedY = -(Math.random() * 1.25 + 0.35);
            this.speedX = (Math.random() - 0.5) * 0.85;
            this.angle = Math.random() * Math.PI * 2;
            this.spin = (Math.random() - 0.5) * 0.035;
            this.type = Math.random() > 0.38 ? 'crimson_ember' : 'black_tendril';
            this.alpha = Math.random() * 0.65 + 0.25;
        }

        update() {
            this.y += this.speedY;
            this.x += this.speedX + Math.sin(this.angle) * 0.3;
            this.angle += this.spin;

            if (mouse.active) {
                const dx = this.x - mouse.x;
                const dy = this.y - mouse.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 130 && dist > 0) {
                    this.x += (dx / dist) * 1.05;
                    this.y += (dy / dist) * 1.05;
                }
            }

            if (this.y < -25 || this.x < -25 || this.x > width + 25) {
                this.reset(false);
            }
        }

        draw() {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.rotate(this.angle);

            if (this.type === 'crimson_ember') {
                // Brasa Carmesí Intensa (#ff1a2d / #e60012)
                ctx.shadowBlur = 14;
                ctx.shadowColor = '#ff1a2d';
                ctx.fillStyle = `rgba(255, 26, 45, ${this.alpha})`;
                ctx.beginPath();
                ctx.moveTo(0, -this.size * 1.45);
                ctx.lineTo(this.size, 0);
                ctx.lineTo(0, this.size * 1.45);
                ctx.lineTo(-this.size, 0);
                ctx.closePath();
                ctx.fill();
            } else {
                // Fragmento de Anti-Magia Negra con contorno Rojo Sangre
                ctx.shadowBlur = 12;
                ctx.shadowColor = '#e60012';
                ctx.fillStyle = `rgba(8, 2, 3, ${this.alpha + 0.2})`;
                ctx.strokeStyle = `rgba(255, 30, 50, ${this.alpha})`;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.rect(-this.size * 0.85, -this.size * 0.85, this.size * 1.7, this.size * 1.7);
                ctx.fill();
                ctx.stroke();
            }

            ctx.restore();
        }
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push(new AntiMagicParticle(true));
    }

    function animate() {
        ctx.clearRect(0, 0, width, height);

        for (let i = 0; i < particles.length; i++) {
            particles[i].update();
            particles[i].draw();

            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const distSq = dx * dx + dy * dy;
                if (distSq < 9200) {
                    const opacity = (1 - distSq / 9200) * 0.16;
                    ctx.strokeStyle = `rgba(255, 26, 45, ${opacity})`;
                    ctx.lineWidth = 0.7;
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.stroke();
                }
            }
        }

        requestAnimationFrame(animate);
    }

    animate();
})();
