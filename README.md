

# OpenDesk

Acesso remoto próprio, construído do zero, no estilo do AnyDesk. O computador controlado roda um único
`.exe`; quem acessa usa só o Chrome, sem extensão nem instalação.

## O que faz

- **Tela em tempo real:** captura por DXGI e H.264 por hardware (Intel Quick Sync, NVIDIA NVENC,
  AMD AMF), com OpenH264 como reserva. 1080p a 60 fps, ajuste automático à rede e baixa latência
  (WebRTC por UDP, conexão direta entre os PCs).
- **Controle total:** mouse, roda, teclas especiais e atalhos, vários monitores e escala de DPI;
  mouse travado na sessão e teclado completo em tela cheia.
- **Arquivos e chat:** envio em blocos com retomada e verificação SHA-256, em canais separados
  para não atrasar o mouse.
- **Acesso seguro:** ID fixo por computador e senha temporária ou pessoal. A senha fica só como
  hash Argon2id, nunca em texto. Há bloqueio progressivo contra tentativas e uma tela de aceite,
  ou aceite automático com a senha pessoal.
- **Modo administrador:** serviço do Windows (SYSTEM) que permite controlar a tela de login, o
  aviso do UAC e programas de administrador, além de enviar Ctrl+Alt+Del.
- **Tudo em um `.exe`:** servidor de conexão, página web e túnel público (Cloudflare) embutidos.
  Um link de download permite instalar em outros PCs.
- **Privacidade:** o vídeo, o controle e os arquivos vão cifrados direto entre os computadores.
  O servidor só apresenta um ao outro.

## Tecnologias

Rust (windows-rs, webrtc-rs, Media Foundation), TypeScript (Node.js + ws, cliente web sem
frameworks), WebRTC, DXGI Desktop Duplication, Argon2id, DPAPI.
