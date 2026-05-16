# Migração de Avatar: localStorage → Firebase Storage

## O que mudou

Avatares de perfil eram armazenados como base64 no `localStorage` do navegador,
o que causa problemas em TWA (Android) e limites de tamanho. A partir desta versão
os avatares são enviados ao **Firebase Storage** (`avatars/{uid}.jpg`) e a URL
permanente é salva no **Firestore** em `users/{uid}/profile/main → avatarUrl`.

## Migração automática

**Nenhuma ação necessária pelo usuário.** No primeiro login após o deploy, o app:

1. Tenta carregar o `avatarUrl` do Firestore.
2. Se não encontrar (usuário antigo), detecta o base64 no `localStorage`.
3. Faz o upload silencioso para o Storage, salva a URL no Firestore e remove a
   entrada do `localStorage`.

O log `[migration] avatar migrado para Storage` aparece no console quando a
migração ocorre com sucesso.

## Comportamento por plataforma

| Plataforma | Comportamento |
|---|---|
| Web | Upload via SDK JS, URL servida diretamente pelo Storage |
| TWA (Android) | Idêntico — WebView usa o mesmo código JS |
| App nativo (Capacitor/RN) | Trocar `uploadBytes` pelo SDK nativo; `_uploadAvatarBlob` em `app.js` isola a lógica |

## Regras de Storage (`storage.rules`)

- Leitura pública (URLs em `<img>` funcionam sem autenticação)
- Escrita restrita ao próprio usuário, máximo 2 MB, apenas `image/*`
