// ===== SOCIAL: TURMAS.JS =====
// 2025-05-15 — Redesign completo: roomId corrigido com period/semester/courseId,
// chat em tempo real estilo WhatsApp, badges de não lidos, presence, typing.

import { db, auth } from '../firebase.js';
import { getFacapeData } from '../facape.js';

import {
  doc, getDoc, setDoc, addDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  serverTimestamp, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Estado local ──────────────────────────────────────────────────────────────
let _unsubChat    = null;
let _unsubTyping  = null;
let _currentChatRoomId = null;
let _presenceInterval  = null;
let _typingClearTimeout = null;
let _roomBadgeListeners = {};
let _unreadCounts = {};

// ── Dados da FACAPE ───────────────────────────────────────────────────────────
export const FACAPE_INSTITUTION  = 'FACAPE';
export const FACAPE_DISPLAY_NAME = 'FACAPE – Faculdade de Petrolina';

export const FACAPE_COURSES = [
  {
    id: 'med', name: 'Medicina', sigla: 'MED', tipo: 'Bacharelado', semestres: 12,
    periodo: ['integral'],
    subjects: {
      1:  ['Bioquímica','Biologia Celular e Molecular','Anatomia Humana I','Histologia','Introdução à Medicina'],
      2:  ['Anatomia Humana II','Fisiologia I','Biofísica','Imunologia','Psicologia Médica'],
      3:  ['Fisiologia II','Microbiologia','Parasitologia','Genética Médica','Semiologia I'],
      4:  ['Farmacologia I','Patologia Geral','Semiologia II','Saúde Coletiva I','Epidemiologia'],
      5:  ['Farmacologia II','Fisiopatologia','Clínica Médica I','Saúde Coletiva II','Bioética'],
      6:  ['Clínica Médica II','Cirurgia Geral I','Ginecologia e Obstetrícia I','Pediatria I','Urgência e Emergência I'],
      7:  ['Clínica Médica III','Cirurgia Geral II','Ginecologia e Obstetrícia II','Pediatria II','Ortopedia e Traumatologia'],
      8:  ['Neurologia','Psiquiatria','Dermatologia','Oftalmologia','Otorrinolaringologia'],
      9:  ['Medicina de Família e Comunidade','Urgência e Emergência II','Medicina Legal','Geriatria','Eletiva I'],
      10: ['Internato em Clínica Médica I','Internato em Cirurgia I','Internato em Pediatria I','Internato em GO I','Internato em Saúde Coletiva I'],
      11: ['Internato em Clínica Médica II','Internato em Cirurgia II','Internato em Pediatria II','Internato em GO II','Internato em Saúde Coletiva II'],
      12: ['Internato em Clínica Médica III','Internato em Cirurgia III','Internato em Urgência/Emergência','Internato em Saúde Mental','TCC'],
    },
  },
  {
    id: 'adm', name: 'Administração', sigla: 'ADM', tipo: 'Bacharelado', semestres: 8,
    periodo: ['matutino','noturno'],
    subjects: {
      1: ['Introdução à Administração','Fundamentos de Contabilidade','Matemática Aplicada','Comunicação Empresarial','Sociologia das Organizações'],
      2: ['Teoria Geral da Administração','Contabilidade Gerencial','Estatística Aplicada','Economia I','Direito Empresarial'],
      3: ['Comportamento Organizacional','Gestão de Marketing','Economia II','Metodologia Científica','Gestão de Pessoas I'],
      4: ['Gestão Financeira I','Gestão de Operações','Pesquisa de Marketing','Gestão de Pessoas II','Ética e Responsabilidade Social'],
      5: ['Gestão Financeira II','Gestão Estratégica I','Comércio Exterior','Gestão Ambiental','Empreendedorismo'],
      6: ['Gestão Estratégica II','Gestão de Projetos','Consultoria Empresarial','Logística e Cadeia de Suprimentos','Tópicos em Administração'],
      7: ['Administração Pública','Gestão do Conhecimento','Negócios Internacionais','Estágio Supervisionado I','TCC I'],
      8: ['Liderança e Inovação','Governança Corporativa','Tópicos Avançados em Adm.','Estágio Supervisionado II','TCC II'],
    },
  },
  {
    id: 'cc_comp', name: 'Ciência da Computação', sigla: 'CC', tipo: 'Bacharelado', semestres: 8,
    periodo: ['matutino','noturno'],
    subjects: {
      1: ['Algoritmos e Programação I','Matemática Discreta','Cálculo I','Introdução à Computação','Comunicação e Expressão'],
      2: ['Algoritmos e Programação II','Álgebra Linear','Cálculo II','Arquitetura de Computadores','Física para Computação'],
      3: ['Estruturas de Dados','Banco de Dados I','Probabilidade e Estatística','Programação Orientada a Objetos','Sistemas Operacionais'],
      4: ['Banco de Dados II','Redes de Computadores','Teoria da Computação','Engenharia de Software I','Análise e Projeto de Sistemas'],
      5: ['Compiladores','Inteligência Artificial','Engenharia de Software II','Computação Gráfica','Tópicos em Computação I'],
      6: ['Segurança da Informação','Computação em Nuvem','Desenvolvimento Web','Sistemas Distribuídos','Tópicos em Computação II'],
      7: ['Desenvolvimento Mobile','Governança de TI','Eletiva I','Estágio Supervisionado I','TCC I'],
      8: ['Empreendedorismo em TI','Eletiva II','Eletiva III','Estágio Supervisionado II','TCC II'],
    },
  },
  {
    id: 'cont', name: 'Ciências Contábeis', sigla: 'CONT', tipo: 'Bacharelado', semestres: 8,
    periodo: ['matutino','noturno'],
    subjects: {
      1: ['Contabilidade Introdutória','Teoria da Contabilidade','Matemática Financeira','Português Instrumental','Direito I'],
      2: ['Contabilidade Intermediária','Análise das Demonstrações Financeiras','Estatística','Direito II','Economia'],
      3: ['Contabilidade Avançada','Auditoria Contábil','Gestão de Custos','Direito Tributário','Metodologia Científica'],
      4: ['Contabilidade Gerencial','Perícia Contábil','Controladoria','Legislação Tributária','Ética Profissional'],
      5: ['Contabilidade Pública I','Sistemas de Informação Contábil','Finanças Corporativas','Gestão Tributária','Contabilidade Internacional'],
      6: ['Contabilidade Pública II','Planejamento Tributário','Mercado de Capitais','Gestão Financeira','Tópicos em Ciências Contábeis'],
      7: ['Auditoria Avançada','Contabilidade Ambiental','Análise de Investimentos','Estágio Supervisionado I','TCC I'],
      8: ['Tópicos Contábeis Avançados','Consultoria Contábil','Governança e Compliance','Estágio Supervisionado II','TCC II'],
    },
  },
  {
    id: 'comex', name: 'Comércio Exterior', sigla: 'COMEX', tipo: 'Bacharelado', semestres: 8,
    periodo: ['matutino','noturno'],
    subjects: {
      1: ['Introdução ao Comércio Exterior','Economia Internacional I','Matemática Financeira','Comunicação Empresarial','Introdução ao Direito'],
      2: ['Logística Internacional','Economia Internacional II','Contabilidade Geral','Direito Aduaneiro','Inglês Instrumental I'],
      3: ['Despacho Aduaneiro','Gestão de Operações Portuárias','Finanças Internacionais I','Direito Internacional','Inglês Instrumental II'],
      4: ['Transporte Internacional','Finanças Internacionais II','Câmbio e Pagamentos Internacionais','Negociação Internacional','Espanhol para Negócios'],
      5: ['Gestão de Exportação','Gestão de Importação','Marketing Internacional','Tributação no Comércio Exterior','Análise de Risco em Comércio Exterior'],
      6: ['Geopolítica e Relações Internacionais','Blocos Econômicos','Gestão Aduaneira','Empreendedorismo Internacional','Tópicos em Comércio Exterior'],
      7: ['Estratégia de Negócios Internacionais','Eletiva I','Eletiva II','Estágio Supervisionado I','TCC I'],
      8: ['Tendências do Comércio Global','Eletiva III','Eletiva IV','Estágio Supervisionado II','TCC II'],
    },
  },
  {
    id: 'dire', name: 'Direito', sigla: 'DIR', tipo: 'Bacharelado', semestres: 10,
    periodo: ['matutino','noturno'],
    subjects: {
      1:  ['Introdução ao Direito','Direito Constitucional I','Direito Civil I','Sociologia Jurídica','Metodologia do Trabalho Científico'],
      2:  ['Direito Constitucional II','Direito Civil II','Direito Penal I','Teoria Geral do Processo','Filosofia do Direito'],
      3:  ['Direito Civil III','Direito Penal II','Direito Processual Civil I','Direito Administrativo I','Direito Tributário I'],
      4:  ['Direito Civil IV','Direito Penal III','Direito Processual Civil II','Direito Administrativo II','Direito Tributário II'],
      5:  ['Direito do Trabalho I','Direito Processual Penal I','Direito Empresarial I','Direito Previdenciário','Ética Profissional'],
      6:  ['Direito do Trabalho II','Direito Processual Penal II','Direito Empresarial II','Direito Internacional','Prática Jurídica I'],
      7:  ['Direito Ambiental','Direitos Humanos','Direito do Consumidor','Eletiva I','Prática Jurídica II'],
      8:  ['Direito Imobiliário','Arbitragem e Mediação','Criminologia','Eletiva II','Prática Jurídica III'],
      9:  ['Tópicos em Direito','Eletiva III','Estágio Supervisionado I','Monografia I','Prática Jurídica IV'],
      10: ['Eletiva IV','Estágio Supervisionado II','Monografia II','Prática Jurídica V','Atividades Complementares'],
    },
  },
  {
    id: 'eco', name: 'Economia', sigla: 'ECO', tipo: 'Bacharelado', semestres: 8,
    periodo: ['matutino','noturno'],
    subjects: {
      1: ['Introdução à Economia','Matemática I','Contabilidade Social','Sociologia Econômica','Comunicação e Expressão'],
      2: ['Microeconomia I','Matemática II','Estatística I','História do Pensamento Econômico','Introdução à Administração'],
      3: ['Microeconomia II','Macroeconomia I','Estatística II','Econometria I','Metodologia Científica'],
      4: ['Macroeconomia II','Econometria II','Economia Brasileira I','Finanças Públicas','Direito Econômico'],
      5: ['Economia Internacional','Economia Brasileira II','Economia do Setor Público','Desenvolvimento Econômico','Moeda e Bancos'],
      6: ['Economia Regional e Urbana','Mercado de Capitais','Economia Agrícola','Análise de Projetos','Tópicos em Economia I'],
      7: ['Economia Ambiental','Gestão Econômica','Eletiva I','Estágio Supervisionado I','TCC I'],
      8: ['Tópicos em Economia II','Eletiva II','Eletiva III','Estágio Supervisionado II','TCC II'],
    },
  },
  {
    id: 'gti', name: 'Gestão da Tecnologia da Informação', sigla: 'GTI', tipo: 'Bacharelado', semestres: 8,
    periodo: ['matutino','noturno'],
    subjects: {
      1: ['Fundamentos de TI','Algoritmos e Lógica de Programação','Matemática Aplicada','Comunicação Empresarial','Introdução à Gestão'],
      2: ['Banco de Dados I','Redes de Computadores I','Sistemas Operacionais','Contabilidade para TI','Gestão de Pessoas'],
      3: ['Banco de Dados II','Redes de Computadores II','Engenharia de Software','Gestão de Projetos de TI','Estatística Aplicada'],
      4: ['Segurança da Informação','Arquitetura de Sistemas','Governança de TI','Gestão Financeira','Análise de Sistemas'],
      5: ['Cloud Computing','Business Intelligence','Gestão de Serviços de TI','Qualidade de Software','Empreendedorismo em TI'],
      6: ['Transformação Digital','Inteligência Artificial Aplicada','Gestão de Riscos em TI','Marketing Digital','Tópicos em GTI'],
      7: ['Inovação e Startups','Eletiva I','Eletiva II','Estágio Supervisionado I','TCC I'],
      8: ['Tendências em TI','Eletiva III','Eletiva IV','Estágio Supervisionado II','TCC II'],
    },
  },
  {
    id: 'ss', name: 'Serviço Social', sigla: 'SS', tipo: 'Bacharelado', semestres: 8,
    periodo: ['matutino','noturno'],
    subjects: {
      1: ['Introdução ao Serviço Social','Sociologia I','Economia Política','Fundamentos Históricos do Serviço Social','Metodologia Científica'],
      2: ['Fundamentos Teórico-Metodológicos I','Sociologia II','Filosofia','Psicologia Social','Políticas Sociais I'],
      3: ['Fundamentos Teórico-Metodológicos II','Direito e Legislação Social','Antropologia','Políticas Sociais II','Ética Profissional'],
      4: ['Processo de Trabalho em Serviço Social I','Seguridade Social','Pesquisa em Serviço Social I','Saúde e Serviço Social','Movimentos Sociais'],
      5: ['Processo de Trabalho em Serviço Social II','Pesquisa em Serviço Social II','Serviço Social e Educação','Questão Agrária','Família e Serviço Social'],
      6: ['Gestão Social','Serviço Social e Assistência Social','Eletiva I','Supervisão de Estágio I','Estágio Supervisionado I'],
      7: ['Tópicos em Serviço Social','Eletiva II','Supervisão de Estágio II','Estágio Supervisionado II','TCC I'],
      8: ['Seminários Temáticos','Eletiva III','Supervisão de Estágio III','Estágio Supervisionado III','TCC II'],
    },
  },
  {
    id: 'psi', name: 'Psicologia', sigla: 'PSI', tipo: 'Bacharelado', semestres: 10,
    periodo: ['matutino','integral'],
    subjects: {
      1:  ['Introdução à Psicologia','Fundamentos de Neurociência','Psicologia do Desenvolvimento I','Sociologia','Filosofia'],
      2:  ['Psicologia do Desenvolvimento II','Psicologia Social I','Teorias da Personalidade','Estatística Aplicada à Psicologia','Metodologia Científica'],
      3:  ['Psicologia Social II','Psicopatologia I','Avaliação Psicológica I','Processos Básicos: Cognição e Percepção','Ética em Psicologia'],
      4:  ['Psicopatologia II','Avaliação Psicológica II','Psicologia Clínica I','Processos Básicos: Motivação e Emoção','Pesquisa em Psicologia'],
      5:  ['Psicologia Clínica II','Psicologia Organizacional I','Psicologia Escolar I','Psicodiagnóstico','Saúde Mental e Saúde Coletiva'],
      6:  ['Psicologia Organizacional II','Psicologia Escolar II','Psicanálise','Psicologia Hospitalar','Eletiva I'],
      7:  ['Psicoterapia Cognitivo-Comportamental','Psicologia Jurídica','Psicologia Comunitária','Eletiva II','Estágio Básico I'],
      8:  ['Psicologia da Saúde','Neuropsicologia','Eletiva III','Estágio Básico II','TCC I'],
      9:  ['Intervenção Clínica Supervisionada I','Intervenção Organizacional Supervisionada','Eletiva IV','Estágio Profissionalizante I','TCC II'],
      10: ['Intervenção Clínica Supervisionada II','Seminários em Psicologia','Eletiva V','Estágio Profissionalizante II','TCC III'],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 60000);
  if (diff < 1)  return 'agora';
  if (diff < 60) return `${diff}min`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function fmtChatTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDaySeparator(date) {
  const now = new Date();
  const toStr = (d) => d.toLocaleDateString('pt-BR');
  if (toStr(date) === toStr(now)) return 'Hoje';
  const yesterday = new Date(now - 86400000);
  if (toStr(date) === toStr(yesterday)) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
}

// ── IA: Análise de grade curricular via Claude API ────────────────────────────
async function analyzeGradeImage(imageBase64, mimeType = 'image/jpeg', targetSemester = null) {
  const semInstrucao = targetSemester
    ? `O usuário informou que está cursando o PERÍODO ${targetSemester}. Retorne APENAS as disciplinas cuja coluna "Período" seja exatamente "${targetSemester}".`
    : `Retorne as disciplinas do período de maior número com aulas regulares (excluindo estágios e TCCs).`;

  const prompt = `Esta é uma imagem do Portal do Aluno da FACAPE (Faculdade de Petrolina – PE).
A grade curricular tem colunas: Período | Código | Disciplina/Descrição | C.H. | C.R. | Pré-Requisito.
${semInstrucao}
Regras: leia TODAS as linhas, filtre pelo período solicitado, capitalize os nomes em português, não inclua estágios/TCCs salvo se forem disciplinas regulares.
Retorne SOMENTE JSON válido:
{"materias":[{"nome":"Nome","codigo":"XX.XX.XX.X.XX"}],"semestre":<número ou null>,"curso":"<nome ou null>"}
Se não conseguir identificar: {"materias":[],"semestre":null,"curso":null}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: prompt },
        ]}],
      }),
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return { materias: [], semestre: null, curso: null };
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed.materias)) {
      parsed.materias = parsed.materias
        .map(m => typeof m === 'string' ? { nome: m, codigo: '' } : { nome: m.nome || m.name || '', codigo: m.codigo || m.code || '' })
        .filter(m => m.nome.trim());
    }
    return parsed;
  } catch (err) {
    console.error('[turmas/ia] Erro:', err);
    return { materias: [], semestre: null, curso: null };
  }
}

// ── Perfil Acadêmico ──────────────────────────────────────────────────────────
export async function loadFullAcademicProfile(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'profile', 'academic'));
    if (snap.exists()) return snap.data();
    return null;
  } catch { return null; }
}

export async function saveFullAcademicProfile(uid, data) {
  try {
    const course = FACAPE_COURSES.find(c => c.id === data.courseId);
    await setDoc(doc(db, 'users', uid, 'profile', 'academic'), {
      institution: data.institution || FACAPE_INSTITUTION,
      course:      data.course || '',
      courseId:    data.courseId || '',
      semester:    parseInt(data.semester) || 1,
      period:      data.period || 'noturno',
      subjects:    data.subjects || [],
      skills:      data.skills || [],
      bio:         data.bio || '',
      updatedAt:   new Date().toISOString(),
    }, { merge: true });

    await setDoc(doc(db, 'user_profiles', uid), {
      institution:  data.institution || FACAPE_INSTITUTION,
      course:       data.course || '',
      courseId:     data.courseId || '',
      semester:     parseInt(data.semester) || 1,
      period:       data.period || 'noturno',
      courseSigla:  course?.sigla || '',
    }, { merge: true });

    return true;
  } catch (err) {
    console.error('[turmas] Erro ao salvar perfil:', err);
    return false;
  }
}

// ── RoomId (CORRIGIDO: inclui courseId, semester, period) ─────────────────────
export function buildRoomId(institution, courseId, semester, period, subjectName, subjectCode) {
  const raw = `${institution}::${courseId}::sem${semester}::${period}::${subjectCode || subjectName}`;
  return raw.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9:]/g, '_')
    .slice(0, 100);
}

// ── Salas de Matéria ──────────────────────────────────────────────────────────
export async function ensureSubjectRoom(institution, courseId, semester, period, subjectName, subjectCode) {
  const id = buildRoomId(institution, courseId, semester, period, subjectName, subjectCode);
  const ref = doc(db, 'subject_rooms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      institution,
      courseId,
      semester:    parseInt(semester),
      period,
      subjectName,
      subjectCode: subjectCode || '',
      memberCount: 0,
      createdAt:   serverTimestamp(),
    });
  }
  return id;
}

export async function joinSubjectRoom(rId, uid) {
  try {
    await setDoc(doc(db, 'subject_rooms', rId, 'members', uid), {
      uid, joinedAt: serverTimestamp(),
    });
    const snap = await getDoc(doc(db, 'subject_rooms', rId));
    const cur = snap.data()?.memberCount || 0;
    await updateDoc(doc(db, 'subject_rooms', rId), { memberCount: cur + 1 });
    return true;
  } catch (err) {
    console.error('[turmas] Erro ao entrar na sala:', err);
    return false;
  }
}

export async function leaveSubjectRoom(rId, uid) {
  try {
    await deleteDoc(doc(db, 'subject_rooms', rId, 'members', uid));
    const snap = await getDoc(doc(db, 'subject_rooms', rId));
    const cur = snap.data()?.memberCount || 1;
    await updateDoc(doc(db, 'subject_rooms', rId), { memberCount: Math.max(0, cur - 1) });
    return true;
  } catch { return false; }
}

export async function isRoomMember(rId, uid) {
  try {
    const snap = await getDoc(doc(db, 'subject_rooms', rId, 'members', uid));
    return snap.exists();
  } catch { return false; }
}

export async function syncUserRooms(uid, profile) {
  if (!profile?.institution || !profile?.subjects?.length) return [];
  const results = [];
  for (const sub of profile.subjects) {
    const rid = await ensureSubjectRoom(
      profile.institution, profile.courseId, profile.semester,
      profile.period, sub.name, sub.code
    );
    const wasMember = await isRoomMember(rid, uid);
    if (!wasMember) await joinSubjectRoom(rid, uid);
    const snap = await getDoc(doc(db, 'subject_rooms', rid));
    results.push({ id: rid, subjectName: sub.name, ...snap.data() });
  }
  return results;
}

export async function listMyRooms(uid) {
  const profile = await loadFullAcademicProfile(uid);
  if (!profile?.subjects?.length || !profile?.institution) return [];

  const rooms = [];
  for (const sub of profile.subjects) {
    const rid = buildRoomId(
      profile.institution, profile.courseId, profile.semester,
      profile.period, sub.name, sub.code
    );
    try {
      let snap = await getDoc(doc(db, 'subject_rooms', rid));
      if (!snap.exists()) {
        await ensureSubjectRoom(
          profile.institution, profile.courseId, profile.semester,
          profile.period, sub.name, sub.code
        );
        await joinSubjectRoom(rid, uid);
        snap = await getDoc(doc(db, 'subject_rooms', rid));
      }
      rooms.push({ id: rid, ...snap.data(), subjectRef: sub, profile });
    } catch { /* ignora salas que falharam */ }
  }
  return rooms;
}

// ── Room Reads (badges de não lidos) ──────────────────────────────────────────
async function updateRoomRead(uid, rId) {
  await setDoc(
    doc(db, 'users', uid, 'roomReads', rId),
    { timestamp: serverTimestamp() }
  );
}

async function getUnreadCount(uid, rId) {
  try {
    const readSnap = await getDoc(doc(db, 'users', uid, 'roomReads', rId));
    if (!readSnap.exists()) {
      const q = query(collection(db, 'subject_rooms', rId, 'messages'), limit(50));
      const snap = await getDocs(q);
      return snap.size;
    }
    const lastRead = readSnap.data().timestamp;
    const q = query(
      collection(db, 'subject_rooms', rId, 'messages'),
      where('createdAt', '>', lastRead)
    );
    const snap = await getDocs(q);
    return snap.size;
  } catch { return 0; }
}

// ── Presence ──────────────────────────────────────────────────────────────────
function startPresence(uid) {
  const ref = doc(db, 'users', uid, 'presence');
  const update = () => setDoc(ref, { lastSeen: serverTimestamp() }, { merge: true });
  update();
  if (_presenceInterval) clearInterval(_presenceInterval);
  _presenceInterval = setInterval(update, 60000);
}

async function getOnlineCount(rId) {
  try {
    const membersSnap = await getDocs(collection(db, 'subject_rooms', rId, 'members'));
    const uids = membersSnap.docs.map(d => d.id);
    const cutoff = new Date(Date.now() - 2 * 60 * 1000);
    const presenceSnaps = await Promise.all(
      uids.map(u => getDoc(doc(db, 'users', u, 'presence')))
    );
    return presenceSnaps.filter(s => {
      if (!s.exists()) return false;
      const ls = s.data().lastSeen?.toDate?.();
      return ls && ls > cutoff;
    }).length;
  } catch { return 0; }
}

// ── Chat Messages ─────────────────────────────────────────────────────────────
export async function sendChatMessage(rId, uid, text) {
  const user = auth.currentUser;
  if (!user || !text?.trim()) return null;
  try {
    const ref = await addDoc(collection(db, 'subject_rooms', rId, 'messages'), {
      authorId:   uid,
      authorName: user.displayName || user.email.split('@')[0],
      text:       text.trim(),
      type:       'text',
      createdAt:  serverTimestamp(),
      deleted:    false,
    });
    return ref.id;
  } catch (err) {
    console.error('[turmas/chat] Erro ao enviar:', err);
    return null;
  }
}

export async function softDeleteMessage(rId, msgId, uid) {
  try {
    const ref = doc(db, 'subject_rooms', rId, 'messages', msgId);
    const snap = await getDoc(ref);
    if (!snap.exists() || snap.data().authorId !== uid) return false;
    await updateDoc(ref, { deleted: true, deletedAt: serverTimestamp() });
    return true;
  } catch { return false; }
}

// ── Typing Indicators ─────────────────────────────────────────────────────────
function _setTyping(rId, uid, displayName) {
  const ref = doc(db, 'subject_rooms', rId, 'typing', uid);
  setDoc(ref, { name: displayName, ts: serverTimestamp() }).catch(() => {});
  if (_typingClearTimeout) clearTimeout(_typingClearTimeout);
  _typingClearTimeout = setTimeout(() => _clearTyping(rId, uid), 3000);
}

function _clearTyping(rId, uid) {
  deleteDoc(doc(db, 'subject_rooms', rId, 'typing', uid)).catch(() => {});
  if (_typingClearTimeout) { clearTimeout(_typingClearTimeout); _typingClearTimeout = null; }
}

// ── Notificações de chat (criadas para o próprio usuário via onSnapshot) ──────
async function _createChatNotif(uid, rId, roomName, msg) {
  try {
    await addDoc(collection(db, 'notifications', uid, 'items'), {
      type:       'chat_message',
      roomId:     rId,
      roomName:   roomName || 'Sala',
      authorName: msg.authorName || 'Colega',
      preview:    (msg.text || '').slice(0, 60),
      createdAt:  serverTimestamp(),
      read:       false,
    });
  } catch { /* notificações são best-effort */ }
}

// ── Listeners de badge em background ─────────────────────────────────────────
function _initRoomBadgeListeners(uid, rooms) {
  Object.values(_roomBadgeListeners).forEach(u => u());
  _roomBadgeListeners = {};

  rooms.forEach(room => {
    const q = query(
      collection(db, 'subject_rooms', room.id, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(1)
    );
    let isFirst = true;
    _roomBadgeListeners[room.id] = onSnapshot(q, async (snap) => {
      if (isFirst) { isFirst = false; return; }
      const msgDoc = snap.docs[0];
      if (!msgDoc) return;
      const msg = msgDoc.data();
      if (msg.authorId === uid) return;
      if (_currentChatRoomId === room.id) return;

      _unreadCounts[room.id] = (_unreadCounts[room.id] || 0) + 1;
      _updateRoomCardBadge(room.id, _unreadCounts[room.id]);
      await _createChatNotif(uid, room.id, room.subjectName, msg);
    });
  });
}

function _updateRoomCardBadge(rId, count) {
  const card = document.querySelector(`[data-room-id="${rId}"]`);
  if (!card) return;
  let badge = card.querySelector('.turma-unread-badge');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'turma-unread-badge';
      const arrow = card.querySelector('.turma-card-arrow');
      if (arrow) arrow.before(badge);
      else card.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : String(count);
  } else if (badge) {
    badge.remove();
  }
}

// ── Renderização da aba Turmas ────────────────────────────────────────────────
export async function renderTurmasTab(uid) {
  const container = document.getElementById('turmas-tab-content');
  if (!container) return;

  container.classList.remove('chat-active');

  // Usa _inferProfileFromApp para pegar courseId mesmo que subjects não estejam salvos
  const saved   = await loadFullAcademicProfile(uid) || {};
  const profile = _inferProfileFromApp(saved);

  if (!profile.courseId) {
    _renderOnboarding(container, uid);
    return;
  }

  _renderTurmaServers(container, uid, profile);
}

// ── Lista de turmas do curso (como servidores) ─────────────────────────────────
function _renderTurmaServers(container, uid, profile) {
  const course = FACAPE_COURSES.find(c => c.id === profile.courseId);
  if (!course) { _renderOnboarding(container, uid); return; }

  const PERIOD_LABEL = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno', integral:'Integral', ead:'EaD' };
  const PERIOD_EMOJI = { matutino:'☀️', vespertino:'🌤️', noturno:'🌙', integral:'📖', ead:'💻' };
  const semester = profile.semester || 1;
  const myPeriod = profile.period   || '';

  container.innerHTML = `
    <div class="turmas-profile-bar">
      <div class="turmas-profile-info">
        <span class="turmas-inst">${esc(FACAPE_DISPLAY_NAME)}</span>
        <span class="turmas-course">${esc(course.name)} · ${semester}º sem · ${esc(PERIOD_LABEL[myPeriod] || myPeriod || '—')}</span>
      </div>
      <button class="turmas-edit-btn" onclick="window.openAcademicSettings()">✏️</button>
    </div>

    <div class="turmas-servers-header">
      <div class="turmas-servers-title">🏛️ Turmas de ${esc(course.sigla)}</div>
      <p class="turmas-servers-sub">Selecione uma turma para ver as salas de matérias</p>
    </div>

    <div class="turmas-servers-list">
      ${course.periodo.map(period => {
        const isMine   = period === myPeriod;
        const subCount = (course.subjects[semester] || []).length;
        return `
          <div class="turma-server-card${isMine ? ' turma-mine' : ''}"
            onclick="window._enterTurma('${esc(profile.courseId)}','${semester}','${period}')">
            <div class="turma-server-icon">${PERIOD_EMOJI[period] || '🎓'}</div>
            <div class="turma-server-info">
              <div class="turma-server-name">
                ${esc(course.sigla)} ${esc(PERIOD_LABEL[period] || period)}
                ${isMine ? '<span class="turma-mine-badge">Minha turma</span>' : ''}
              </div>
              <div class="turma-server-meta" id="ts-meta-${period}">
                ${semester}º Período · ${subCount} sala${subCount !== 1 ? 's' : ''}
              </div>
            </div>
            <div class="turma-server-arrow">›</div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Carrega contagem de membros em background (não-fatal)
  _loadTurmaMemberCounts(course.periodo, profile.courseId);
}

async function _loadTurmaMemberCounts(periods, courseId) {
  try {
    const snap = await getDocs(query(collection(db, 'user_profiles'), where('courseId', '==', courseId)));
    const byPeriod = {};
    snap.docs.forEach(d => {
      const p = d.data().period || '';
      byPeriod[p] = (byPeriod[p] || 0) + 1;
    });
    periods.forEach(period => {
      const count = byPeriod[period] || 0;
      const el    = document.getElementById(`ts-meta-${period}`);
      if (el && count > 0) {
        const curr = el.textContent;
        el.textContent = curr + ` · 👥 ${count} aluno${count !== 1 ? 's' : ''}`;
      }
    });
  } catch { /* non-fatal */ }
}

// ── Entrar em uma turma (mostra salas de matérias) ────────────────────────────
window._enterTurma = async function(courseId, semester, period) {
  const container = document.getElementById('turmas-tab-content');
  if (!container) return;

  const course = FACAPE_COURSES.find(c => c.id === courseId);
  if (!course) return;

  const uid    = auth.currentUser?.uid;
  const semInt = parseInt(semester);

  // Se for a turma do próprio usuário, usa as matérias do perfil (vindas do portal FACAPE)
  // Para turmas de outros períodos, usa o dado estático como fallback
  let subjectNames = course.subjects[semInt] || [];
  if (uid) {
    const myProfile = await loadFullAcademicProfile(uid).catch(() => null);
    if (myProfile?.courseId === courseId && myProfile?.period === period && myProfile?.subjects?.length) {
      subjectNames = myProfile.subjects.map(s => s.name || s.nome || '').filter(Boolean);
    }
  }

  const PERIOD_LABEL = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno', integral:'Integral', ead:'EaD' };

  const rooms = subjectNames.map(name => ({
    id:          buildRoomId(FACAPE_INSTITUTION, courseId, semInt, period, name, ''),
    subjectName: name,
  }));

  // Mostra estrutura imediatamente com loading nos botões
  container.innerHTML = `
    <div class="turmas-inner-header">
      <button class="turmas-back-btn" onclick="window._renderTurmaListGlobal()">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 12H5M12 5l-7 7 7 7"/>
        </svg>
      </button>
      <div class="turmas-inner-title">
        ${esc(course.sigla)} ${esc(PERIOD_LABEL[period] || period)} · ${semInt}º Sem
      </div>
    </div>

    <div class="turmas-rooms-list" id="turmas-rooms-list">
      ${rooms.length ? rooms.map(room => `
        <div class="turma-card" data-room-id="${room.id}">
          <div class="turma-card-left">
            <div class="turma-card-icon">💬</div>
            <div class="turma-card-info">
              <span class="turma-card-name">${esc(room.subjectName)}</span>
              <span class="turma-card-meta" id="meta-${room.id}">👥 ...</span>
            </div>
          </div>
          <div class="turma-card-action">
            <button class="turma-room-btn turma-room-btn--loading" id="btn-${room.id}" disabled>...</button>
          </div>
        </div>
      `).join('') : `<div class="turmas-empty">Nenhuma matéria encontrada para este semestre.</div>`}
    </div>
  `;

  // Carrega estado de cada sala em paralelo (membro? não-lidos? membros?)
  if (uid && rooms.length) {
    const [memberFlags, unreadArr] = await Promise.all([
      Promise.all(rooms.map(r => isRoomMember(r.id, uid))),
      Promise.all(rooms.map(r => getUnreadCount(uid, r.id))),
    ]);

    rooms.forEach((room, i) => {
      const isMember = memberFlags[i];
      const unread   = unreadArr[i];
      _unreadCounts[room.id] = unread;

      // Atualiza botão
      const btn = document.getElementById(`btn-${room.id}`);
      if (btn) {
        btn.disabled  = false;
        if (isMember) {
          btn.textContent = unread > 0 ? `Abrir (${unread})` : 'Abrir';
          btn.className   = 'turma-room-btn turma-room-btn--open';
          btn.onclick     = () => window._openChat(room.id);
        } else {
          btn.textContent = 'Entrar';
          btn.className   = 'turma-room-btn turma-room-btn--join';
          btn.onclick     = () => window._turmaJoinRoom(
            room.id, courseId, semInt, period, room.subjectName, btn
          );
        }
      }
    });

    // Busca contagem de membros de cada sala (não-bloqueante)
    rooms.forEach(async room => {
      try {
        const snap = await getDoc(doc(db, 'subject_rooms', room.id));
        const el = document.getElementById(`meta-${room.id}`);
        if (el) el.textContent = `👥 ${snap.data()?.memberCount || 0} membro(s)`;
      } catch { /* non-fatal */ }
    });

    _initRoomBadgeListeners(uid, rooms);
  }
};

// ── Entrar em sala a partir da aba Turmas ─────────────────────────────────────
window._turmaJoinRoom = async function(roomId, courseId, semester, period, subjectName, btn) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    await ensureSubjectRoom(FACAPE_INSTITUTION, courseId, parseInt(semester), period, subjectName, '');
    const ok = await joinSubjectRoom(roomId, uid);

    if (ok) {
      if (typeof showToast === 'function') showToast(`✅ Você entrou em ${subjectName}!`);
      if (btn) {
        btn.disabled  = false;
        btn.textContent = 'Abrir';
        btn.className   = 'turma-room-btn turma-room-btn--open';
        btn.onclick     = () => window._openChat(roomId);
      }
      // Atualiza meta de membros no card
      const metaEl = document.getElementById(`meta-${roomId}`);
      if (metaEl) {
        const snap = await getDoc(doc(db, 'subject_rooms', roomId)).catch(() => null);
        if (snap) metaEl.textContent = `👥 ${snap.data()?.memberCount || 1} membro(s)`;
      }
      // Recarrega aba Salas em background para incluir a nova sala
      import('./groups.js').then(({ renderGroupsSection }) =>
        renderGroupsSection(uid)
      ).catch(() => {});
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
    }
  } catch (err) {
    console.error('[turmas] _turmaJoinRoom:', err);
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
  }
};


// ── Helper global: volta para a lista de turmas ────────────────────────────────
window._renderTurmaListGlobal = function() {
  const uid = auth.currentUser?.uid;
  if (uid) renderTurmasTab(uid);
};

// ── Onboarding ────────────────────────────────────────────────────────────────
function _renderOnboarding(container, uid) {
  container.innerHTML = `
    <div class="turmas-onboarding">
      <div class="turmas-onboarding-icon">🎓</div>
      <h3 class="turmas-onboarding-title">Configure seu Perfil Acadêmico</h3>
      <p class="turmas-onboarding-desc">Informe sua faculdade e matérias para interagir com seus colegas de turma.</p>
      <button class="btn-primary turmas-onboarding-btn" onclick="window.openAcademicSettings()">
        Configurar agora
      </button>
    </div>
  `;
}

// ── Inferir perfil a partir dos dados já existentes no app ───────────────────
function _inferProfileFromApp(profile) {
  const facape = getFacapeData();
  const stateSubjects = window._STATE_subjects?.() || [];

  const filled = { ...profile };

  // Tentar mapear curso do FACAPE para um courseId da lista
  if (!filled.courseId && facape?.curso) {
    const cursoNorm = facape.curso.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const match = FACAPE_COURSES.find(c => {
      const cn = c.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const sn = c.sigla.toLowerCase();
      return cursoNorm.includes(cn.split(' ')[0]) || cursoNorm.includes(sn) || cn.includes(cursoNorm.split(' ')[0]);
    });
    if (match) {
      filled.courseId = match.id;
      filled.course   = filled.course || match.name;
    }
  }

  // Inferir semestre e período a partir de facape.periodo (ex: "5º Período Noturno")
  if (facape?.periodo) {
    const p = facape.periodo.toLowerCase();
    if (!filled.semester) {
      const semMatch = p.match(/(\d+)/);
      if (semMatch) filled.semester = parseInt(semMatch[1]);
    }
    if (!filled.period) {
      if (p.includes('noturno'))     filled.period = 'noturno';
      else if (p.includes('matutin')) filled.period = 'matutino';
      else if (p.includes('vespert')) filled.period = 'vespertino';
      else if (p.includes('integral')) filled.period = 'integral';
      else if (p.includes('ead'))     filled.period = 'ead';
    }
  }

  // Coletar matérias: FACAPE + STATE.subjects (sem duplicar por nome)
  if (!filled.subjects?.length) {
    const seen = new Set();
    const merged = [];

    const addSub = (name, code) => {
      const key = name.toLowerCase().trim();
      if (!seen.has(key)) { seen.add(key); merged.push({ name, code: code || '' }); }
    };

    (facape?.materias || []).forEach(m => addSub(m.nome, m.codigo));
    stateSubjects.forEach(s => addSub(s.name || s.nome || '', ''));

    if (merged.length) filled.subjects = merged;
  }

  return filled;
}

window.openTurmasOnboarding = async function() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const saved = await loadFullAcademicProfile(uid) || {};
  const profile = _inferProfileFromApp(saved);

  const courseOptions = FACAPE_COURSES.map(c =>
    `<option value="${c.id}" ${profile.courseId === c.id ? 'selected' : ''}>${esc(c.name)} (${c.tipo})</option>`
  ).join('');

  openModal('🎓 Perfil Acadêmico', `
    <div class="turmas-form">
      <div class="form-group">
        <label class="form-label">Instituição de Ensino</label>
        <div class="turmas-inst-block">
          <span>🏛️</span>
          <div>
            <div class="turmas-inst-name">${esc(FACAPE_DISPLAY_NAME)}</div>
            <div class="turmas-inst-city">Petrolina – PE</div>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Curso *</label>
        <select id="ta-course-id" class="form-select" onchange="window._taOnCourseChange()">
          <option value="">Selecione seu curso...</option>
          ${courseOptions}
        </select>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Semestre</label>
          <input id="ta-semester" class="form-input" type="number" min="1" max="12"
            value="${profile.semester || 1}" onchange="window._taOnCourseChange()">
        </div>
        <div class="form-group">
          <label class="form-label">Período</label>
          <select id="ta-period" class="form-select">
            <option value="matutino"   ${profile.period === 'matutino'   ? 'selected' : ''}>Matutino</option>
            <option value="vespertino" ${profile.period === 'vespertino' ? 'selected' : ''}>Vespertino</option>
            <option value="noturno"    ${(profile.period === 'noturno' || !profile.period) ? 'selected' : ''}>Noturno</option>
            <option value="integral"   ${profile.period === 'integral'   ? 'selected' : ''}>Integral</option>
            <option value="ead"        ${profile.period === 'ead'        ? 'selected' : ''}>EaD</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">📸 Importar Grade pelo Portal (IA)</label>
        <div class="turmas-ia-upload" id="ta-ia-upload-area">
          <label for="ta-grade-img" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px">
            <span style="font-size:28px">🤖</span>
            <span style="font-weight:600;color:var(--accent)">Enviar print do portal aluno</span>
            <span style="font-size:12px;color:var(--text-muted);text-align:center">
              Selecione seu período acima e envie o print da grade curricular — a IA filtrará as matérias do período informado
            </span>
            <input type="file" id="ta-grade-img" accept="image/*" style="display:none" onchange="window._taAnalyzeImage()">
          </label>
        </div>
        <div id="ta-ia-status" style="margin-top:6px;font-size:13px;color:var(--accent);display:none"></div>
      </div>

      <div class="form-group">
        <label class="form-label">Minhas Matérias</label>
        <div id="ta-semester-subjects" class="turmas-semester-subjects" style="margin-bottom:8px"></div>
        <div class="turmas-subjects-list" id="ta-subjects-list"></div>
        <div class="turmas-add-subject" style="margin-top:8px;display:flex;gap:8px">
          <input id="ta-sub-name" class="form-input" placeholder="Adicionar matéria manualmente" style="flex:2">
          <button class="btn-secondary" onclick="window._taAddSubject()" style="white-space:nowrap">+ Adicionar</button>
        </div>
      </div>

      <button class="btn-primary" id="ta-save-btn" onclick="window._taSave()" style="width:100%;margin-top:8px">
        💾 Salvar e Entrar nas Turmas
      </button>
    </div>
  `);

  let subjects = profile.subjects ? [...profile.subjects] : [];
  _renderSubjectChips();
  if (profile.courseId) window._taOnCourseChange();

  window._taOnCourseChange = function() {
    const courseId = document.getElementById('ta-course-id')?.value;
    const semester = parseInt(document.getElementById('ta-semester')?.value) || 1;
    const course = FACAPE_COURSES.find(c => c.id === courseId);
    const el = document.getElementById('ta-semester-subjects');
    if (!el) return;
    if (!course) { el.innerHTML = ''; return; }
    _renderSemesterSubjects(el, course, semester);
  };

  function _renderSemesterSubjects(el, course, semester) {
    const subs = course.subjects[semester] || [];
    if (!subs.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">
        Matérias do ${semester}º semestre de ${esc(course.name)} — toque para adicionar:
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${subs.map(s => `
          <button class="turmas-quick-sub-btn"
            onclick="window._taQuickAdd('${esc(s)}')">${esc(s)}</button>
        `).join('')}
      </div>
      <button onclick="window._taAddAllSemester()" class="turmas-add-all-btn">
        ➕ Adicionar todas do semestre
      </button>
    `;
  }

  window._taQuickAdd = function(name) {
    if (subjects.find(s => s.name.toLowerCase() === name.toLowerCase())) {
      showToast('Matéria já adicionada'); return;
    }
    subjects.push({ name, code: '' });
    _renderSubjectChips();
  };

  window._taQuickAddWithCode = function(nome, codigo) {
    if (subjects.find(s => s.name.toLowerCase() === nome.toLowerCase())) {
      showToast('Matéria já adicionada'); return;
    }
    subjects.push({ name: nome, code: codigo });
    _renderSubjectChips();
  };

  window._taAddAllSemester = function() {
    const courseId  = document.getElementById('ta-course-id')?.value;
    const semester  = parseInt(document.getElementById('ta-semester')?.value) || 1;
    const course    = FACAPE_COURSES.find(c => c.id === courseId);
    if (!course) return;
    let added = 0;
    (course.subjects[semester] || []).forEach(name => {
      if (!subjects.find(s => s.name.toLowerCase() === name.toLowerCase())) {
        subjects.push({ name, code: '' }); added++;
      }
    });
    _renderSubjectChips();
    if (added) showToast(`✅ ${added} matéria(s) adicionada(s)`);
  };

  window._taAnalyzeImage = async function() {
    const file = document.getElementById('ta-grade-img')?.files?.[0];
    if (!file) return;
    const targetSemester = parseInt(document.getElementById('ta-semester')?.value) || null;
    const statusEl   = document.getElementById('ta-ia-status');
    const uploadArea = document.getElementById('ta-ia-upload-area');
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = `🤖 Analisando...`; }
    if (uploadArea) uploadArea.style.opacity = '0.5';

    const base64 = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result.split(',')[1]);
      reader.onerror = () => rej(new Error('Falha ao ler imagem'));
      reader.readAsDataURL(file);
    });

    const result = await analyzeGradeImage(base64, file.type || 'image/jpeg', targetSemester);
    if (uploadArea) uploadArea.style.opacity = '1';

    if (!result.materias?.length) {
      if (statusEl) { statusEl.style.color = '#e05252'; statusEl.textContent = '❌ Nenhuma matéria identificada. Tente outra imagem.'; }
      return;
    }

    if (result.curso) {
      const matched = FACAPE_COURSES.find(c =>
        c.name.toLowerCase().includes(result.curso.toLowerCase()) ||
        result.curso.toLowerCase().includes(c.sigla.toLowerCase())
      );
      if (matched) {
        const sel = document.getElementById('ta-course-id');
        if (sel) sel.value = matched.id;
      }
    }

    const el = document.getElementById('ta-semester-subjects');
    if (el) {
      el.innerHTML = `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;display:flex;align-items:center;gap:5px">
          <span style="background:rgba(108,99,255,.15);color:var(--accent);padding:2px 7px;border-radius:20px;font-size:11px;font-weight:700">🤖 IA</span>
          ${result.materias.length} matéria(s) identificada(s) — toque para adicionar:
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${result.materias.map(m => `
            <button class="turmas-quick-sub-btn"
              onclick="window._taQuickAddWithCode('${esc(m.nome)}','${esc(m.codigo || '')}')"
              title="${esc(m.codigo || '')}">${esc(m.nome)}</button>
          `).join('')}
        </div>
        <button onclick="window._taAddAllIA()" class="turmas-add-all-btn">➕ Adicionar todas da IA</button>
      `;
      window._iaLastResult = result.materias;
    }

    if (statusEl) { statusEl.style.color = '#2ed573'; statusEl.textContent = `✅ ${result.materias.length} matéria(s) encontrada(s)!`; }
    showToast(`🤖 IA encontrou ${result.materias.length} matéria(s)!`);
  };

  window._taAddAllIA = function() {
    let added = 0;
    (window._iaLastResult || []).forEach(m => {
      if (!subjects.find(s => s.name.toLowerCase() === m.nome.toLowerCase())) {
        subjects.push({ name: m.nome, code: m.codigo || '' }); added++;
      }
    });
    _renderSubjectChips();
    if (added) showToast(`✅ ${added} matéria(s) adicionada(s)`);
  };

  function _renderSubjectChips() {
    const el = document.getElementById('ta-subjects-list');
    if (!el) return;
    if (!subjects.length) {
      el.innerHTML = `<span class="turmas-no-subjects">Nenhuma matéria adicionada ainda</span>`;
      return;
    }
    el.innerHTML = subjects.map((s, i) => `
      <div class="turmas-subject-chip">
        <span>${esc(s.name)}${s.code ? ` <small>(${esc(s.code)})</small>` : ''}</span>
        <button onclick="window._taRemoveSubject(${i})" title="Remover">×</button>
      </div>
    `).join('');
  }

  window._taAddSubject = function() {
    const name = document.getElementById('ta-sub-name')?.value?.trim();
    if (!name) { showToast('Digite o nome da matéria'); return; }
    if (subjects.find(s => s.name.toLowerCase() === name.toLowerCase())) {
      showToast('Matéria já adicionada'); return;
    }
    subjects.push({ name, code: '' });
    const el = document.getElementById('ta-sub-name');
    if (el) el.value = '';
    _renderSubjectChips();
  };

  window._taRemoveSubject = function(idx) {
    subjects.splice(idx, 1);
    _renderSubjectChips();
  };

  window._taSave = async function() {
    const courseId = document.getElementById('ta-course-id')?.value;
    const semester = parseInt(document.getElementById('ta-semester')?.value) || 1;
    const period   = document.getElementById('ta-period')?.value || 'noturno';

    if (!courseId)      { showToast('Selecione seu curso'); return; }
    if (!subjects.length) { showToast('Adicione pelo menos uma matéria'); return; }

    const course     = FACAPE_COURSES.find(c => c.id === courseId);
    const courseName = course?.name || courseId;

    const btn = document.getElementById('ta-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    const ok = await saveFullAcademicProfile(uid, {
      institution: FACAPE_INSTITUTION,
      course: courseName,
      courseId,
      semester,
      period,
      subjects,
    });

    if (!ok) {
      showToast('Erro ao salvar. Tente novamente.');
      if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar e Entrar nas Turmas'; }
      return;
    }

    showToast('⏳ Entrando nas turmas...');
    const joinedRooms = await syncUserRooms(uid, {
      institution: FACAPE_INSTITUTION,
      courseId,
      semester,
      period,
      subjects,
    });

    closeModal();
    _showJoinConfirmation(joinedRooms, uid);
  };
};

function _showJoinConfirmation(joinedRooms, uid) {
  openModal('🎉 Turmas Configuradas!', `
    <div class="turmas-confirmation">
      <div class="confirmation-icon">🎓</div>
      <p>Você agora faz parte de <strong>${joinedRooms.length} turma${joinedRooms.length !== 1 ? 's' : ''}</strong>:</p>
      <div class="confirmation-rooms-list">
        ${joinedRooms.map(r => `
          <div class="confirmation-room">
            <span>📚</span>
            <div>
              <div class="confirmation-room-name">${esc(r.subjectName)}</div>
              <div class="confirmation-room-count">👥 ${r.memberCount || 1} aluno${(r.memberCount || 1) !== 1 ? 's' : ''}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <button class="btn-primary" onclick="closeModal(); window._reloadTurmasTab()">
        Ver minhas turmas →
      </button>
    </div>
  `);
}

window._reloadTurmasTab = function() {
  const uid = auth.currentUser?.uid;
  if (uid) renderTurmasTab(uid);
};

// ── Chat View ─────────────────────────────────────────────────────────────────
window._openChat = async function(rId) {
  const uid  = auth.currentUser?.uid;
  const user = auth.currentUser;
  if (!uid) return;

  const snap = await getDoc(doc(db, 'subject_rooms', rId));
  if (!snap.exists()) { showToast('Sala não encontrada'); return; }
  const roomData = snap.data();

  _unreadCounts[rId] = 0;
  _currentChatRoomId = rId;
  await updateRoomRead(uid, rId);

  const container = document.getElementById('turmas-tab-content');
  if (!container) return;
  container.classList.add('chat-active');

  const periodLabel = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno', integral:'Integral', ead:'EaD' };
  const per = periodLabel[roomData.period] || roomData.period || '';

  container.innerHTML = `
    <div class="turmas-chat-view">
      <div class="chat-header">
        <button class="chat-back-btn" onclick="window._closeChat()" aria-label="Voltar">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
        </button>
        <div class="chat-header-info">
          <div class="chat-header-title">${esc(roomData.subjectName)}</div>
          <div class="chat-header-sub" id="chat-online-label">
            👥 ${roomData.memberCount || 0} membros · <span id="chat-online-count">⏳</span>
          </div>
        </div>
      </div>

      <div class="chat-messages" id="chat-messages">
        <div class="chat-loading">⏳ Carregando mensagens...</div>
      </div>

      <div class="chat-typing-indicator" id="chat-typing" style="display:none"></div>

      <div class="chat-input-bar">
        <textarea id="chat-input-text" class="chat-input-textarea"
          placeholder="Mensagem..." rows="1"
          oninput="window._chatInputResize(this)"
          onkeydown="window._chatInputKeydown(event, '${rId}')"></textarea>
        <button class="chat-send-btn" onclick="window._chatSend('${rId}')" aria-label="Enviar">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    </div>
  `;

  // Online count (assíncrono)
  getOnlineCount(rId).then(count => {
    const el = document.getElementById('chat-online-count');
    if (el) el.textContent = `🟢 ${count} online`;
  });

  // Listener de mensagens
  const q = query(
    collection(db, 'subject_rooms', rId, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(100)
  );

  let isFirstLoad = true;
  _unsubChat = onSnapshot(q, (chatSnap) => {
    const messagesEl = document.getElementById('chat-messages');
    if (!messagesEl) return;

    if (chatSnap.empty) {
      messagesEl.innerHTML = '<div class="chat-empty">Nenhuma mensagem ainda. Diga olá! 👋</div>';
      return;
    }

    const messages = chatSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    messagesEl.innerHTML = _renderChatMessages(messages, uid);
    _addLongPressHandlers(uid, rId);

    if (isFirstLoad) {
      isFirstLoad = false;
      _scrollToBottom(messagesEl);
    } else {
      const { scrollTop, scrollHeight, clientHeight } = messagesEl;
      if (scrollHeight - scrollTop - clientHeight < 150) _scrollToBottom(messagesEl);
    }
  }, (err) => {
    console.error('[turmas/chat] Listener error:', err);
    const el = document.getElementById('chat-messages');
    if (el) el.innerHTML = '<div class="chat-error">Erro ao carregar. Verifique sua conexão.</div>';
  });

  // Listener de typing
  _unsubTyping = onSnapshot(collection(db, 'subject_rooms', rId, 'typing'), (typSnap) => {
    const typers = typSnap.docs.filter(d => d.id !== uid).map(d => d.data().name);
    const el = document.getElementById('chat-typing');
    if (!el) return;
    if (typers.length > 0) {
      el.style.display = 'block';
      el.textContent = typers.length === 1
        ? `${typers[0]} está digitando...`
        : `${typers.length} pessoas estão digitando...`;
    } else {
      el.style.display = 'none';
    }
  });

  // Foca o input
  setTimeout(() => document.getElementById('chat-input-text')?.focus(), 300);
};

window._closeChat = function() {
  if (_unsubChat)   { _unsubChat();   _unsubChat = null; }
  if (_unsubTyping) { _unsubTyping(); _unsubTyping = null; }

  const uid = auth.currentUser?.uid;
  if (uid && _currentChatRoomId) _clearTyping(_currentChatRoomId, uid);

  _currentChatRoomId = null;

  const container = document.getElementById('turmas-tab-content');
  if (container) container.classList.remove('chat-active');

  const uidLocal = auth.currentUser?.uid;
  if (uidLocal) renderTurmasTab(uidLocal);
};

function _renderChatMessages(messages, uid) {
  let lastDateStr = null;
  const parts = [];

  messages.forEach(msg => {
    const date = msg.createdAt?.toDate?.() || new Date();
    const dateStr = date.toLocaleDateString('pt-BR');
    if (dateStr !== lastDateStr) {
      lastDateStr = dateStr;
      parts.push(`<div class="chat-day-sep"><span>${esc(formatDaySeparator(date))}</span></div>`);
    }
    parts.push(_renderMsgBubble(msg, uid));
  });

  return parts.join('');
}

function _renderMsgBubble(msg, uid) {
  const isOwn = msg.authorId === uid;

  if (msg.deleted) {
    return `
      <div class="chat-msg-row ${isOwn ? 'own' : 'other'}">
        <div class="chat-bubble deleted"><em>Mensagem apagada</em></div>
      </div>
    `;
  }

  // Detecta links no texto
  const textHtml = esc(msg.text || '').replace(
    /(https?:\/\/[^\s&lt;&gt;]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>'
  );

  const fileHtml = msg.fileUrl
    ? `<a href="${esc(msg.fileUrl)}" target="_blank" rel="noopener" class="chat-file">📎 ${esc(msg.fileName || 'Arquivo')}</a>`
    : '';

  const delBtn = isOwn
    ? `<button class="chat-del-btn" onclick="window._chatDelete('${_currentChatRoomId}','${msg.id}')" title="Apagar">🗑️</button>`
    : '';

  return `
    <div class="chat-msg-row ${isOwn ? 'own' : 'other'}" data-msg-id="${msg.id}">
      ${!isOwn ? `<div class="chat-msg-author">${esc(msg.authorName || 'Colega')}</div>` : ''}
      <div class="chat-bubble ${isOwn ? 'own' : 'other'}">
        ${delBtn}
        <div class="chat-text">${textHtml}${fileHtml}</div>
        <div class="chat-time">${fmtChatTime(msg.createdAt)}</div>
      </div>
    </div>
  `;
}

function _scrollToBottom(el) {
  if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function _addLongPressHandlers(uid, rId) {
  document.querySelectorAll('.chat-msg-row.own').forEach(row => {
    const msgId = row.dataset.msgId;
    if (!msgId) return;
    let timer = null;
    row.addEventListener('touchstart', () => {
      timer = setTimeout(() => {
        if (confirm('Apagar esta mensagem?')) window._chatDelete(rId, msgId);
      }, 650);
    }, { passive: true });
    row.addEventListener('touchend',  () => clearTimeout(timer));
    row.addEventListener('touchmove', () => clearTimeout(timer));
  });
}

window._chatSend = async function(rId) {
  const input = document.getElementById('chat-input-text');
  const text = input?.value?.trim();
  if (!text) return;

  const uid  = auth.currentUser?.uid;
  const user = auth.currentUser;
  if (!uid) return;

  input.value = '';
  input.style.height = 'auto';
  _clearTyping(rId, uid);

  await sendChatMessage(rId, uid, text);
};

window._chatInputKeydown = function(e, rId) {
  if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) {
    e.preventDefault();
    window._chatSend(rId);
  }
};

window._chatInputResize = function(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 96) + 'px';

  const uid  = auth.currentUser?.uid;
  const user = auth.currentUser;
  if (uid && _currentChatRoomId) {
    _setTyping(_currentChatRoomId, uid, user?.displayName || 'Colega');
  }
};

window._chatDelete = async function(rId, msgId) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  if (!confirm('Apagar esta mensagem?')) return;
  const ok = await softDeleteMessage(rId, msgId, uid);
  if (!ok) showToast('Não foi possível apagar a mensagem.');
};

// ── Inicialização ─────────────────────────────────────────────────────────────
export function initTurmas() {
  _injectStyles();
  const uid = auth.currentUser?.uid;
  if (uid) startPresence(uid);
}

function _injectStyles() {
  if (document.getElementById('turmas-chat-styles')) return;
  const style = document.createElement('style');
  style.id = 'turmas-chat-styles';
  style.textContent = `
    /* ── Chat overlay ── */
    #turmas-tab-content.chat-active {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 100;
      background: var(--bg, #0f0f23);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .turmas-chat-view {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    /* ── Header ── */
    .chat-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border, #2a2a3e);
      flex-shrink: 0;
      background: var(--bg-secondary, #1a1a2e);
    }
    .chat-back-btn {
      background: none;
      border: none;
      color: var(--text, #e0e0e0);
      cursor: pointer;
      padding: 6px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      -webkit-tap-highlight-color: transparent;
    }
    .chat-back-btn:active { background: rgba(255,255,255,.1); }
    .chat-header-info { flex: 1; min-width: 0; }
    .chat-header-title {
      font-weight: 600;
      font-size: 15px;
      color: var(--text, #e0e0e0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .chat-header-sub { font-size: 12px; color: var(--text-muted, #888); margin-top: 1px; }

    /* ── Messages area ── */
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 12px 4px;
      -webkit-overflow-scrolling: touch;
    }
    .chat-loading, .chat-empty, .chat-error {
      text-align: center;
      color: var(--text-muted, #888);
      padding: 32px 16px;
      font-size: 14px;
    }

    /* ── Day separator ── */
    .chat-day-sep {
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 16px 0 8px;
    }
    .chat-day-sep span {
      font-size: 11px;
      color: var(--text-muted, #888);
      background: var(--bg-secondary, #1a1a2e);
      padding: 3px 10px;
      border-radius: 12px;
    }

    /* ── Message rows ── */
    .chat-msg-row {
      display: flex;
      flex-direction: column;
      margin-bottom: 6px;
    }
    .chat-msg-row.own { align-items: flex-end; }
    .chat-msg-row.other { align-items: flex-start; }
    .chat-msg-author {
      font-size: 11px;
      color: var(--accent, #7c5cfc);
      font-weight: 600;
      margin-bottom: 2px;
      padding-left: 4px;
    }

    /* ── Bubbles ── */
    .chat-bubble {
      position: relative;
      max-width: min(75vw, 320px);
      padding: 8px 12px 22px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.45;
      word-break: break-word;
    }
    .chat-bubble.own {
      background: var(--accent, #7c5cfc);
      color: #fff;
      border-bottom-right-radius: 4px;
    }
    .chat-bubble.other {
      background: var(--bg-secondary, #1e1e38);
      color: var(--text, #e0e0e0);
      border-bottom-left-radius: 4px;
    }
    .chat-bubble.deleted {
      background: transparent;
      border: 1px solid var(--border, #333);
      color: var(--text-muted, #888);
      font-style: italic;
      padding: 6px 12px;
    }
    .chat-time {
      position: absolute;
      bottom: 4px;
      right: 10px;
      font-size: 10px;
      opacity: .7;
    }
    .chat-del-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      background: none;
      border: none;
      font-size: 12px;
      cursor: pointer;
      opacity: 0;
      transition: opacity .15s;
      -webkit-tap-highlight-color: transparent;
    }
    .chat-bubble:hover .chat-del-btn,
    .chat-bubble:active .chat-del-btn { opacity: .8; }
    .chat-link {
      color: rgba(255,255,255,.85);
      text-decoration: underline;
      word-break: break-all;
    }
    .chat-bubble.other .chat-link { color: var(--accent, #7c5cfc); }
    .chat-file {
      display: block;
      margin-top: 4px;
      font-size: 13px;
      opacity: .9;
      text-decoration: none;
    }

    /* ── Typing indicator ── */
    .chat-typing-indicator {
      font-size: 12px;
      color: var(--text-muted, #888);
      padding: 2px 16px 4px;
      font-style: italic;
      flex-shrink: 0;
    }

    /* ── Input bar ── */
    .chat-input-bar {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 8px 12px;
      border-top: 1px solid var(--border, #2a2a3e);
      background: var(--bg, #0f0f23);
      flex-shrink: 0;
    }
    .chat-input-textarea {
      flex: 1;
      background: var(--bg-secondary, #1e1e38);
      border: 1px solid var(--border, #333);
      border-radius: 20px;
      padding: 8px 14px;
      color: var(--text, #e0e0e0);
      font-size: 14px;
      font-family: inherit;
      resize: none;
      line-height: 1.4;
      max-height: 96px;
      overflow-y: auto;
      outline: none;
    }
    .chat-input-textarea:focus { border-color: var(--accent, #7c5cfc); }
    .chat-send-btn {
      width: 40px; height: 40px;
      border-radius: 50%;
      background: var(--accent, #7c5cfc);
      border: none;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
      transition: transform .1s;
    }
    .chat-send-btn:active { transform: scale(.9); }

    /* ── Room cards badges ── */
    .turma-unread-badge {
      background: #e74c3c;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      border-radius: 10px;
      padding: 2px 7px;
      min-width: 20px;
      text-align: center;
      flex-shrink: 0;
    }
    .turma-card-meta {
      font-size: 11px;
      color: var(--text-muted, #888);
      margin-top: 1px;
    }

    /* ── Onboarding extras ── */
    .turmas-inst-block {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--bg-secondary, #1a1a2e);
      border-radius: 8px;
      border: 1px solid var(--border, #333);
      font-size: 18px;
    }
    .turmas-inst-name { font-weight: 600; color: var(--text, #e0e0e0); }
    .turmas-inst-city { font-size: 12px; color: var(--text-muted, #888); }
    .turmas-ia-upload {
      border: 2px dashed var(--accent, #7c5cfc);
      border-radius: 10px;
      background: rgba(124,92,252,.05);
    }
    .turmas-semester-subjects {
      padding: 10px;
      background: var(--bg-secondary, #1a1a2e);
      border-radius: 8px;
      border: 1px solid var(--border, #333);
    }
    .turmas-quick-sub-btn {
      padding: 4px 10px;
      border-radius: 20px;
      border: 1px solid var(--accent, #7c5cfc);
      background: transparent;
      color: var(--accent, #7c5cfc);
      cursor: pointer;
      font-size: 12px;
      -webkit-tap-highlight-color: transparent;
    }
    .turmas-quick-sub-btn:active { background: var(--accent, #7c5cfc); color: #fff; }
    .turmas-add-all-btn {
      margin-top: 8px;
      font-size: 12px;
      padding: 4px 12px;
      border-radius: 6px;
      border: 1px solid var(--border, #333);
      background: transparent;
      color: var(--text-muted, #888);
      cursor: pointer;
    }
    .btn-link {
      background: none;
      border: none;
      color: var(--accent, #7c5cfc);
      cursor: pointer;
      text-decoration: underline;
      font-size: inherit;
    }

    /* ── Confirmation screen ── */
    .turmas-confirmation {
      text-align: center;
      padding: 8px 0;
    }
    .turmas-confirmation .confirmation-icon { font-size: 40px; margin-bottom: 8px; }
    .confirmation-rooms-list {
      margin: 16px 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 250px;
      overflow-y: auto;
    }
    .confirmation-room {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: var(--bg-secondary, #1a1a2e);
      border-radius: 10px;
      text-align: left;
    }
    .confirmation-room-name { font-weight: 600; font-size: 13px; }
    .confirmation-room-count { font-size: 12px; color: var(--text-muted, #888); }

    /* ── Profile bar (top of turmas screen) ── */
    .turmas-profile-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--bg-secondary, #1a1a2e);
      border-bottom: 1px solid var(--border, #2a2a3e);
      flex-shrink: 0;
    }
    .turmas-profile-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .turmas-inst {
      font-size: 11px;
      color: var(--text-muted, #888);
      text-transform: uppercase;
      letter-spacing: .5px;
      font-weight: 600;
    }
    .turmas-course {
      font-size: 13px;
      font-weight: 600;
      color: var(--text, #e0e0e0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .turmas-edit-btn {
      background: none;
      border: none;
      font-size: 18px;
      cursor: pointer;
      padding: 6px;
      border-radius: 8px;
      color: var(--text-muted, #888);
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }
    .turmas-edit-btn:active { background: rgba(255,255,255,.08); }

    /* ── Servers list header ── */
    .turmas-servers-header {
      padding: 20px 16px 8px;
    }
    .turmas-servers-title {
      font-size: 17px;
      font-weight: 700;
      color: var(--text, #e0e0e0);
      margin-bottom: 4px;
    }
    .turmas-servers-sub {
      font-size: 13px;
      color: var(--text-muted, #888);
      margin: 0;
    }
    .turmas-servers-list {
      padding: 8px 12px 24px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* ── Server card ── */
    .turma-server-card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 14px;
      background: var(--bg-secondary, #1a1a2e);
      border: 1px solid var(--border, #2a2a3e);
      border-radius: 14px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      transition: border-color .15s, background .15s;
    }
    .turma-server-card:active { background: rgba(255,255,255,.04); }
    .turma-server-card.turma-mine {
      border-color: var(--accent, #7c5cfc);
      background: rgba(124,92,252,.07);
    }
    .turma-server-icon {
      font-size: 28px;
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,.05);
      border-radius: 12px;
      flex-shrink: 0;
    }
    .turma-server-info { flex: 1; min-width: 0; }
    .turma-server-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--text, #e0e0e0);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .turma-server-meta {
      font-size: 12px;
      color: var(--text-muted, #888);
      margin-top: 3px;
    }
    .turma-mine-badge {
      font-size: 10px;
      font-weight: 700;
      color: var(--accent, #7c5cfc);
      background: rgba(124,92,252,.15);
      border-radius: 10px;
      padding: 2px 8px;
    }
    .turma-server-arrow {
      font-size: 22px;
      color: var(--text-muted, #888);
      flex-shrink: 0;
      line-height: 1;
    }

    /* ── Inner header (back button + title) ── */
    .turmas-inner-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border, #2a2a3e);
      background: var(--bg-secondary, #1a1a2e);
      flex-shrink: 0;
    }
    .turmas-back-btn {
      background: none;
      border: none;
      color: var(--text, #e0e0e0);
      cursor: pointer;
      padding: 6px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      -webkit-tap-highlight-color: transparent;
      flex-shrink: 0;
    }
    .turmas-back-btn:active { background: rgba(255,255,255,.1); }
    .turmas-inner-title {
      font-weight: 700;
      font-size: 15px;
      color: var(--text, #e0e0e0);
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── Room list (subject rooms) ── */
    .turmas-rooms-list {
      padding: 8px 12px 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .turma-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      background: var(--bg-secondary, #1a1a2e);
      border: 1px solid var(--border, #2a2a3e);
      border-radius: 12px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      transition: border-color .15s;
    }
    .turma-card:active { border-color: var(--accent, #7c5cfc); }
    .turma-card-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
      min-width: 0;
    }
    .turma-card-icon {
      font-size: 22px;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,.05);
      border-radius: 10px;
      flex-shrink: 0;
    }
    .turma-card-info { flex: 1; min-width: 0; }
    .turma-card-name {
      font-weight: 600;
      font-size: 13px;
      color: var(--text, #e0e0e0);
      display: block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .turma-card-arrow {
      font-size: 20px;
      color: var(--text-muted, #888);
      flex-shrink: 0;
      margin-left: 8px;
    }
    .turma-card-action { flex-shrink: 0; margin-left: 8px; }
    .turma-room-btn {
      padding: 7px 16px;
      border-radius: 20px;
      border: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity .15s, transform .1s;
      -webkit-tap-highlight-color: transparent;
    }
    .turma-room-btn:active { transform: scale(.95); }
    .turma-room-btn:disabled { opacity: .5; cursor: default; }
    .turma-room-btn--loading { background: rgba(255,255,255,.08); color: var(--text-muted,#888); }
    .turma-room-btn--join { background: var(--accent, #7c5cfc); color: #fff; }
    .turma-room-btn--join:hover { opacity: .88; }
    .turma-room-btn--open { background: rgba(124,92,252,.15); color: var(--accent, #7c5cfc); border: 1px solid rgba(124,92,252,.3); }
    .turmas-empty {
      text-align: center;
      color: var(--text-muted, #888);
      font-size: 14px;
      padding: 32px 16px;
    }

    /* ── Onboarding screen ── */
    .turmas-onboarding {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      text-align: center;
      gap: 12px;
    }
    .turmas-onboarding-icon { font-size: 52px; }
    .turmas-onboarding-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text, #e0e0e0);
      margin: 0;
    }
    .turmas-onboarding-desc {
      font-size: 14px;
      color: var(--text-muted, #888);
      margin: 0;
      max-width: 280px;
    }
    .turmas-onboarding-btn {
      margin-top: 8px;
      padding: 12px 28px;
      font-size: 15px;
    }
  `;
  document.head.appendChild(style);
}
