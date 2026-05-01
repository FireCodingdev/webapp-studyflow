# Firestore Schema — StudyFlow Social

> Documentação das coleções novas e expandidas. Não altera as coleções `users` (dados de estudo) existentes — apenas adiciona subcoleções e novas coleções.

---

## Coleções Existentes (sem alteração)

| Coleção | Descrição |
|---------|-----------|
| `users/{uid}` | Dados de estudo: subjects, classes, tasks, flashcards |
| `user_profiles/{uid}` | Perfil básico para busca de destinatário de cards |

---

## Subcoleção Nova — Perfil Acadêmico

### `users/{uid}/profile/academic`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `institution` | string | Instituição de ensino |
| `course` | string | Curso/graduação |
| `semester` | number | Semestre atual |
| `skills` | string[] | Habilidades e matérias destaque |
| `bio` | string | Bio acadêmica |
| `projects` | array | Projetos acadêmicos (futuro) |
| `updatedAt` | string (ISO) | Última atualização |

---

## Campo Novo em `users/{uid}`

```json
{
  "social": {
    "followers": 0,
    "following": 0,
    "reputation": 0
  }
}
```

---

## Coleção Nova — Feed de Posts

### `posts/{postId}`

| Campo | Tipo | Valores |
|-------|------|---------|
| `authorId` | string | UID do autor |
| `authorName` | string | Nome do autor |
| `type` | string | `"doubt"` \| `"material"` \| `"achievement"` \| `"flashcard"` |
| `content` | string | Conteúdo do post |
| `subjectId` | string | ID da matéria (opcional) |
| `likes` | number | Contagem de likes |
| `replies` | array | Lista de respostas inline |
| `visibility` | string | `"public"` \| `"group"` \| `"connections"` |
| `reportCount` | number | Número de denúncias |
| `createdAt` | timestamp | Firestore server timestamp |

---

## Coleção Nova — Conexões

### `connections/{uid}`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `following` | string[] | UIDs que o usuário segue |
| `followers` | string[] | UIDs que seguem o usuário |

---

## Coleção Nova — Grupos/Salas

### `groups/{groupId}`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `name` | string | Nome do grupo |
| `subject` | string | Disciplina associada |
| `institution` | string | Instituição (opcional) |
| `members` | string[] | UIDs dos membros |
| `posts` | array | Posts do grupo (inline ou referências) |
| `createdAt` | timestamp | Data de criação |
| `createdBy` | string | UID do criador |

---

## Coleção Nova — Notificações

### `notifications/{uid}/items/{notifId}`

| Campo | Tipo | Valores |
|-------|------|---------|
| `type` | string | `"like"` \| `"reply"` \| `"follow"` \| `"achievement"` |
| `fromUser` | string | UID de quem gerou a notificação |
| `postId` | string | ID do post (quando aplicável) |
| `read` | boolean | Se foi lida |
| `createdAt` | timestamp | Data/hora |

---

## Coleção Nova — Denúncias (Moderação)

### `reports/{reportId}`

| Campo | Tipo | Valores |
|-------|------|---------|
| `postId` | string | Post denunciado |
| `reportedBy` | string | UID do denunciante |
| `reason` | string | `"spam"` \| `"inappropriate"` \| `"harassment"` \| etc |
| `status` | string | `"pending"` \| `"reviewed"` \| `"dismissed"` |
| `createdAt` | timestamp | Data/hora |

---

## Índices Recomendados no Firestore Console

```
posts: createdAt DESC
posts: authorId ASC, createdAt DESC
notifications/{uid}/items: read ASC, createdAt DESC
groups: subject ASC, createdAt DESC
reports: status ASC, createdAt DESC
```

---

## Coleção Nova — Salas de Matéria (Turmas)

### `subject_rooms/{roomId}`

> `roomId` é gerado automaticamente como slug de `{institution}::{subjectCode|subjectName}` (ex: `ufpe__calculo_ii`)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `institution` | string | Instituição de ensino |
| `subjectName` | string | Nome da disciplina |
| `subjectCode` | string | Código da disciplina (ex: IF778) |
| `memberCount` | number | Quantidade de alunos inscritos |
| `createdAt` | timestamp | Data de criação |

### `subject_rooms/{roomId}/members/{uid}`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `uid` | string | UID do membro |
| `joinedAt` | timestamp | Data de inscrição |

### `subject_rooms/{roomId}/posts/{postId}`

| Campo | Tipo | Valores |
|-------|------|---------|
| `authorId` | string | UID do autor |
| `authorName` | string | Nome do autor |
| `type` | string | `"discussao"` \| `"aviso"` \| `"link"` \| `"documento"` \| `"imagem"` |
| `content` | string | Conteúdo da publicação (até 3000 chars) |
| `fileUrl` | string \| null | URL de arquivo/imagem (opcional) |
| `fileName` | string \| null | Nome do arquivo (opcional) |
| `likes` | string[] | UIDs que curtiram |
| `createdAt` | timestamp | Firestore server timestamp |

### Campo expandido em `users/{uid}/profile/academic`

Agora inclui o campo `subjects`:

```json
{
  "institution": "UFPE",
  "course": "Engenharia de Software",
  "semester": 3,
  "period": "noturno",
  "subjects": [
    { "name": "Cálculo II", "code": "MA026" },
    { "name": "Programação Orientada a Objetos", "code": "IF678" }
  ],
  "skills": ["Python", "UX"],
  "bio": "...",
  "updatedAt": "2025-..."
}
```

## Índices Adicionais Recomendados

```
subject_rooms/{roomId}/posts: createdAt DESC
subject_rooms/{roomId}/members: joinedAt DESC
```
