# Acessar pelo endereço (URL pública)

O servidor de sinalização também entrega a página do visualizador. Publicá-lo com HTTPS dá um endereço do tipo `https://remoto.exemplo.com`. Abrindo esse endereço no Chrome, de qualquer lugar, você conecta ao PC que tem o agente instalado.

```
Chrome (qualquer lugar) ──https/wss──► servidor (Render ou túnel) ◄──wss── agente no PC controlado
            └───────────── vídeo, mouse, teclado e arquivos: direto (WebRTC/UDP) ─────────────┘
```

O servidor só faz o "aperto de mão". O vídeo e o controle vão direto entre as duas máquinas, cifrados ponta a ponta.

## Opção A: URL temporária agora (Cloudflare Tunnel, sem conta)

Neste PC, no PowerShell, na pasta do projeto:

```powershell
.\scripts\url-temporaria.ps1
```

Procure a linha `https://<nomes>.trycloudflare.com`. É a URL. No PC que será controlado:

```powershell
.\remoto-agent.exe install --server wss://<nomes>.trycloudflare.com/ws
```

- A URL **muda a cada execução** e só funciona enquanto o PowerShell estiver aberto e este PC ligado. Ao mudar a URL, reinstale o agente com a nova (o ID e a pasta continuam os mesmos).
- **Testado:** abrindo `https://heating-craig-previews-councils.trycloudflare.com` (a URL daquela execução), a conexão com senha + aceite funcionou, com vídeo 1920×1080 pelo Quick Sync.

## Opção B: URL fixa grátis no Render (recomendado)

O projeto já tem `Dockerfile` e `render.yaml`. Você precisa de duas contas gratuitas: **GitHub** e **Render**. Elas são suas, e a senha e as confirmações por e-mail ficam com você.

1. **GitHub → New repository** (pode ser privado), por exemplo `remoto`.
2. Envie a pasta do projeto para o repositório:
   - **sem instalar nada:** na página do repositório, *uploading an existing file*, e arraste as pastas `protocol`, `signaling`, `web-client` e os arquivos `package.json`, `package-lock.json`, `tsconfig.base.json`, `Dockerfile`, `.dockerignore`, `render.yaml`;
   - **ou com Git:** `git init`, `git add .`, `git commit -m "Remoto"`, `git remote add origin …`, `git push`. O `.gitignore` já deixa de fora `node_modules`, executáveis e `dist`.
3. **Render → New → Blueprint →** conecte o GitHub e escolha o repositório. O `render.yaml` cria o serviço `remoto` (Docker, plano gratuito, verificação em `/healthz`).
4. Em ~3 a 5 minutos o Render mostra o endereço: `https://remoto-xxxx.onrender.com`.
5. No PC que será controlado:
   ```powershell
   .\remoto-agent.exe install --server wss://remoto-xxxx.onrender.com/ws
   ```
6. De qualquer lugar: abra `https://remoto-xxxx.onrender.com` no Chrome e informe o ID e a senha.

**Plano gratuito do Render:** o serviço "dorme" após 15 min sem tráfego e leva ~1 min para acordar. O agente mantém a conexão aberta e reconecta sozinho, então normalmente o serviço fica acordado enquanto um PC com o agente estiver ligado. Para não depender disso, use um plano pago (a partir de ~US$ 7/mês) ou uma VPS.

**Domínio próprio:** no Render, *Settings → Custom Domains* (HTTPS automático).

**Para não precisar do `--server`:** compile o agente com o endereço fixo:

```powershell
$env:REMOTO_SERVIDOR_PADRAO = "wss://remoto-xxxx.onrender.com/ws"; cd agent; cargo build --release
```

Aí basta dar dois cliques no `remoto-agent.exe` e responder "Sim" para instalar.

## Redes que bloqueiam conexão direta (TURN)

Na maioria das redes (casa, 4G, escritório comum) a conexão direta funciona com o STUN padrão. Em algumas redes corporativas, ou com NAT simétrico, ela falha. O visualizador mostra "Falha na conexão P2P (verifique STUN/TURN)". Nesse caso é preciso um servidor **TURN** (coturn), que retransmite o vídeo.

O Render não roda TURN, porque não tem UDP. O caminho é uma VPS pequena com o coturn configurado como em [arquitetura.md §7](arquitetura.md) e, no Render, as variáveis `TURN_URLS` e `TURN_SECRET` (já previstas no `render.yaml`, comentadas).

## Segurança da URL pública

- Qualquer pessoa pode abrir a página. Para **entrar** num PC é preciso o ID, a senha temporária (só visível naquele PC) **e** o aceite de quem está nele. Senhas erradas causam bloqueio progressivo.
- O servidor limita tentativas de ID por IP. Com `TRUST_PROXY=1` (já configurado), ele vê o IP real atrás do Render ou da Cloudflare.
- A senha e o conteúdo da sessão não passam pelo servidor: vão cifrados direto entre as máquinas.
