// ===== SOCIAL: TURMAS.JS =====
// Sistema de Turmas vinculadas à FACAPE – Faculdade de Petrolina.
// Alunos selecionam curso/matérias e entram em grupos pré-existentes.
// IA analisa imagens de grade curricular para extração automática de matérias.

import { db, auth } from '../firebase.js';

import {
  doc, getDoc, setDoc, addDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  serverTimestamp, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Estado local ──────────────────────────────────────────────────────────────
let _unsubMural = null;
let _currentRoomId = null;

// ── Dados da FACAPE ───────────────────────────────────────────────────────────
// Fonte: https://facape.otimizeit.com.br/graduacao-pos/
export const FACAPE_INSTITUTION = 'FACAPE';
export const FACAPE_DISPLAY_NAME = 'FACAPE – Faculdade de Petrolina';

export const FACAPE_COURSES = [
  {
    id: 'ads',
    name: 'Análise e Desenvolvimento de Sistemas',
    sigla: 'ADS',
    tipo: 'Tecnólogo',
    semestres: 5,
    periodo: ['matutino', 'noturno'],
    subjects: {
      1: ['Fundamentos de TI', 'Algoritmos e Programação I', 'Matemática Discreta', 'Comunicação e Expressão', 'Engenharia de Software I'],
      2: ['Algoritmos e Programação II', 'Banco de Dados I', 'Redes de Computadores', 'Sistemas Operacionais', 'Engenharia de Software II'],
      3: ['Desenvolvimento Web', 'Banco de Dados II', 'Programação Orientada a Objetos', 'Estruturas de Dados', 'Gestão de Projetos de TI'],
      4: ['Desenvolvimento Mobile', 'Segurança da Informação', 'Inteligência Artificial', 'Tópicos em TI', 'Estágio Supervisionado I'],
      5: ['Sistemas Distribuídos', 'Governança de TI', 'Empreendedorismo em TI', 'Estágio Supervisionado II', 'Trabalho de Conclusão de Curso'],
    },
  },
  {
    id: 'adm',
    name: 'Administração',
    sigla: 'ADM',
    tipo: 'Bacharelado',
    semestres: 8,
    periodo: ['matutino', 'noturno'],
    subjects: {
      1: ['Introdução à Administração', 'Fundamentos de Contabilidade', 'Matemática Aplicada', 'Comunicação Empresarial', 'Sociologia das Organizações'],
      2: ['Teoria Geral da Administração', 'Contabilidade Gerencial', 'Estatística Aplicada', 'Economia I', 'Direito Empresarial'],
      3: ['Comportamento Organizacional', 'Gestão de Marketing', 'Economia II', 'Metodologia Científica', 'Gestão de Pessoas I'],
      4: ['Gestão Financeira I', 'Gestão de Operações', 'Pesquisa de Marketing', 'Gestão de Pessoas II', 'Ética e Responsabilidade Social'],
      5: ['Gestão Financeira II', 'Gestão Estratégica I', 'Comércio Exterior', 'Gestão Ambiental', 'Empreendedorismo'],
      6: ['Gestão Estratégica II', 'Gestão de Projetos', 'Consultoria Empresarial', 'Logística e Cadeia de Suprimentos', 'Tópicos em Administração'],
      7: ['Administração Pública', 'Gestão do Conhecimento', 'Negócios Internacionais', 'Estágio Supervisionado I', 'TCC I'],
      8: ['Liderança e Inovação', 'Governança Corporativa', 'Tópicos Avançados em Adm.', 'Estágio Supervisionado II', 'TCC II'],
    },
  },
  {
    id: 'cc',
    name: 'Ciências Contábeis',
    sigla: 'CC',
    tipo: 'Bacharelado',
    semestres: 8,
    periodo: ['matutino', 'noturno'],
    subjects: {
      1: ['Contabilidade Introdutória', 'Teoria da Contabilidade', 'Matemática Financeira', 'Português Instrumental', 'Direito I'],
      2: ['Contabilidade Intermediária', 'Análise das Demonstrações Financeiras', 'Estatística', 'Direito II', 'Economia'],
      3: ['Contabilidade Avançada', 'Auditoria Contábil', 'Gestão de Custos', 'Direito Tributário', 'Metodologia Científica'],
      4: ['Contabilidade Gerencial', 'Perícia Contábil', 'Controladoria', 'Legislação Tributária', 'Ética Profissional'],
      5: ['Contabilidade Pública I', 'Sistemas de Informação Contábil', 'Finanças Corporativas', 'Gestão Tributária', 'Contabilidade Internacional'],
      6: ['Contabilidade Pública II', 'Planejamento Tributário', 'Mercado de Capitais', 'Gestão Financeira', 'Tópicos em Ciências Contábeis'],
      7: ['Auditoria Avançada', 'Contabilidade Ambiental', 'Análise de Investimentos', 'Estágio Supervisionado I', 'TCC I'],
      8: ['Tópicos Contábeis Avançados', 'Consultoria Contábil', 'Governança e Compliance', 'Estágio Supervisionado II', 'TCC II'],
    },
  },
  {
    id: 'dire',
    name: 'Direito',
    sigla: 'DIR',
    tipo: 'Bacharelado',
    semestres: 10,
    periodo: ['matutino', 'noturno'],
    subjects: {
      1: ['Introdução ao Direito', 'Direito Constitucional I', 'Direito Civil I', 'Sociologia Jurídica', 'Metodologia do Trabalho Científico'],
      2: ['Direito Constitucional II', 'Direito Civil II', 'Direito Penal I', 'Teoria Geral do Processo', 'Filosofia do Direito'],
      3: ['Direito Civil III', 'Direito Penal II', 'Direito Processual Civil I', 'Direito Administrativo I', 'Direito Tributário I'],
      4: ['Direito Civil IV', 'Direito Penal III', 'Direito Processual Civil II', 'Direito Administrativo II', 'Direito Tributário II'],
      5: ['Direito do Trabalho I', 'Direito Processual Penal I', 'Direito Empresarial I', 'Direito Previdenciário', 'Ética Profissional'],
      6: ['Direito do Trabalho II', 'Direito Processual Penal II', 'Direito Empresarial II', 'Direito Internacional', 'Prática Jurídica I'],
      7: ['Direito Ambiental', 'Direitos Humanos', 'Direito do Consumidor', 'Eletiva I', 'Prática Jurídica II'],
      8: ['Direito Imobiliário', 'Arbitragem e Mediação', 'Criminologia', 'Eletiva II', 'Prática Jurídica III'],
      9: ['Tópicos em Direito', 'Eletiva III', 'Estágio Supervisionado I', 'Monografia I', 'Prática Jurídica IV'],
      10: ['Eletiva IV', 'Estágio Supervisionado II', 'Monografia II', 'Prática Jurídica V', 'Atividades Complementares'],
    },
  },
  {
    id: 'eng_civil',
    name: 'Engenharia Civil',
    sigla: 'ENG-CIV',
    tipo: 'Bacharelado',
    semestres: 10,
    periodo: ['matutino'],
    subjects: {
      1: ['Cálculo I', 'Geometria Analítica', 'Desenho Técnico', 'Introdução à Engenharia Civil', 'Química Geral'],
      2: ['Cálculo II', 'Álgebra Linear', 'Física I', 'Programação para Engenharia', 'Materiais de Construção I'],
      3: ['Cálculo III', 'Física II', 'Estatística', 'Mecânica dos Sólidos', 'Materiais de Construção II'],
      4: ['Cálculo Numérico', 'Física III', 'Resistência dos Materiais I', 'Mecânica dos Solos I', 'Topografia'],
      5: ['Hidrologia', 'Resistência dos Materiais II', 'Mecânica dos Solos II', 'Estruturas de Concreto I', 'Saneamento Ambiental'],
      6: ['Hidráulica', 'Estruturas de Concreto II', 'Estruturas de Aço', 'Fundações', 'Instalações Hidrossanitárias'],
      7: ['Estradas', 'Estruturas de Madeira', 'Gerenciamento de Obras', 'Instalações Elétricas', 'Meio Ambiente e Sustentabilidade'],
      8: ['Patologia das Construções', 'Planejamento e Controle de Obras', 'Orçamento de Obras', 'Eletiva I', 'Estágio Supervisionado I'],
      9: ['Segurança do Trabalho', 'Eletiva II', 'Eletiva III', 'Estágio Supervisionado II', 'TCC I'],
      10: ['Eletiva IV', 'Estágio Supervisionado III', 'TCC II', 'Atividades Complementares', 'Empreendedorismo'],
    },
  },
  {
    id: 'eng_prod',
    name: 'Engenharia de Produção',
    sigla: 'ENG-PROD',
    tipo: 'Bacharelado',
    semestres: 10,
    periodo: ['matutino'],
    subjects: {
      1: ['Cálculo I', 'Geometria Analítica', 'Introdução à Engenharia de Produção', 'Química Tecnológica', 'Algoritmos e Programação'],
      2: ['Cálculo II', 'Álgebra Linear', 'Física I', 'Estatística I', 'Materiais para Produção'],
      3: ['Cálculo III', 'Física II', 'Estatística II', 'Processos de Fabricação I', 'Termodinâmica'],
      4: ['Pesquisa Operacional I', 'Processos de Fabricação II', 'Resistência dos Materiais', 'Ergonomia', 'Contabilidade e Finanças'],
      5: ['Pesquisa Operacional II', 'Planejamento e Controle da Produção', 'Controle de Qualidade', 'Logística', 'Gestão de Projetos'],
      6: ['Gestão de Estoques', 'Simulação de Sistemas', 'Gestão da Manutenção', 'Higiene e Segurança do Trabalho', 'Empreendedorismo'],
      7: ['Gestão de Cadeia de Suprimentos', 'Lean Manufacturing', 'Gestão Ambiental', 'Eletiva I', 'Estágio Supervisionado I'],
      8: ['Engenharia Econômica', 'Gestão da Inovação', 'Tópicos em Eng. Produção', 'Eletiva II', 'Estágio Supervisionado II'],
      9: ['Eletiva III', 'Eletiva IV', 'Estágio Supervisionado III', 'TCC I', 'Atividades Complementares'],
      10: ['Eletiva V', 'Estágio Supervisionado IV', 'TCC II', 'Atividades Complementares II', 'Desenvolvimento de Carreira'],
    },
  },
  {
    id: 'enf',
    name: 'Enfermagem',
    sigla: 'ENF',
    tipo: 'Bacharelado',
    semestres: 10,
    periodo: ['integral'],
    subjects: {
      1: ['Anatomia Humana', 'Bioquímica', 'Biologia Celular', 'Introdução à Enfermagem', 'Saúde Coletiva I'],
      2: ['Fisiologia', 'Histologia', 'Farmacologia I', 'Fundamentos de Enfermagem', 'Saúde Coletiva II'],
      3: ['Microbiologia e Parasitologia', 'Farmacologia II', 'Enfermagem em Saúde do Adulto I', 'Ética e Legislação', 'Nutrição'],
      4: ['Patologia', 'Enfermagem em Saúde do Adulto II', 'Saúde Mental', 'Semiologia e Semiotécnica', 'Epidemiologia'],
      5: ['Enfermagem em UTI', 'Cirurgia e Centro Cirúrgico', 'Saúde da Mulher', 'Enfermagem Pediátrica I', 'Genética'],
      6: ['Saúde do Idoso', 'Enfermagem Pediátrica II', 'Doenças Infecciosas', 'Urgência e Emergência', 'Bioestatística'],
      7: ['Gestão em Saúde', 'Educação em Saúde', 'Eletiva I', 'Estágio Supervisionado I', 'TCC I'],
      8: ['Atenção Primária à Saúde', 'Sistematização da Assistência de Enfermagem', 'Eletiva II', 'Estágio Supervisionado II', 'TCC II'],
      9: ['Estágio Integrado I', 'Eletiva III', 'TCC III', 'Atividades Complementares I', 'Tópicos em Enfermagem'],
      10: ['Estágio Integrado II', 'Eletiva IV', 'TCC IV', 'Atividades Complementares II', 'Desenvolvimento Profissional'],
    },
  },
  {
    id: 'far',
    name: 'Farmácia',
    sigla: 'FAR',
    tipo: 'Bacharelado',
    semestres: 10,
    periodo: ['matutino', 'integral'],
    subjects: {
      1: ['Química Geral', 'Biologia Celular e Molecular', 'Anatomia e Fisiologia I', 'Introdução à Farmácia', 'Matemática e Estatística'],
      2: ['Química Orgânica', 'Anatomia e Fisiologia II', 'Microbiologia', 'Farmacognosia I', 'Bioquímica'],
      3: ['Química Analítica', 'Parasitologia', 'Farmacognosia II', 'Farmacologia I', 'Imunologia'],
      4: ['Físico-Química', 'Farmacologia II', 'Toxicologia', 'Deontologia e Legislação', 'Biofarmácia'],
      5: ['Tecnologia Farmacêutica I', 'Análises Clínicas I', 'Cosmetologia', 'Epidemiologia', 'Farmácia Hospitalar I'],
      6: ['Tecnologia Farmacêutica II', 'Análises Clínicas II', 'Atenção Farmacêutica', 'Farmácia Hospitalar II', 'Vigilância Sanitária'],
      7: ['Biotecnologia Farmacêutica', 'Homeopatia', 'Farmácia Comunitária', 'Eletiva I', 'Estágio Supervisionado I'],
      8: ['Fitoterapia', 'Genética e Genômica', 'Tópicos em Farmácia', 'Eletiva II', 'Estágio Supervisionado II'],
      9: ['Estágio em Análises Clínicas', 'Estágio em Tecnologia', 'TCC I', 'Eletiva III', 'Atividades Complementares I'],
      10: ['Estágio em Atenção Farmacêutica', 'TCC II', 'Eletiva IV', 'Atividades Complementares II', 'Desenvolvimento Profissional'],
    },
  },
  {
    id: 'geo_anal_alg',
    name: 'Gestão Ambiental',
    sigla: 'GEO ANAL ALG',
    tipo: 'Tecnólogo',
    semestres: 4,
    periodo: ['matutino', 'noturno'],
    subjects: {
      1: ['Ecologia Geral', 'Química Ambiental', 'Gestão Ambiental I', 'Legislação Ambiental', 'Metodologia Científica'],
      2: ['Gestão Ambiental II', 'Saneamento Ambiental', 'Geoprocessamento', 'Avaliação de Impacto Ambiental', 'Educação Ambiental'],
      3: ['Gestão de Recursos Hídricos', 'Gestão de Resíduos Sólidos', 'Auditoria Ambiental', 'Eletiva I', 'Estágio Supervisionado I'],
      4: ['Perícia Ambiental', 'Sustentabilidade e Negócios', 'Eletiva II', 'Estágio Supervisionado II', 'TCC'],
    },
  },
  {
    id: 'letras',
    name: 'Letras - Língua Portuguesa',
    sigla: 'LETRAS',
    tipo: 'Licenciatura',
    semestres: 8,
    periodo: ['matutino', 'noturno'],
    subjects: {
      1: ['Língua Portuguesa I', 'Literatura Brasileira I', 'Linguística I', 'Filosofia da Educação', 'Didática'],
      2: ['Língua Portuguesa II', 'Literatura Brasileira II', 'Linguística II', 'Psicologia da Educação', 'Sociologia da Educação'],
      3: ['Língua Portuguesa III', 'Literatura Portuguesa I', 'Linguística Textual', 'Políticas Educacionais', 'Estágio Supervisionado I'],
      4: ['Língua Portuguesa IV', 'Literatura Portuguesa II', 'Fonética e Fonologia', 'Libras', 'Estágio Supervisionado II'],
      5: ['Morfologia', 'Literatura Africana de Língua Portuguesa', 'Análise do Discurso', 'Eletiva I', 'Estágio Supervisionado III'],
      6: ['Sintaxe', 'Literatura Infanto-Juvenil', 'Produção Textual Acadêmica', 'Eletiva II', 'Estágio Supervisionado IV'],
      7: ['Semântica e Pragmática', 'Literatura Comparada', 'Eletiva III', 'TCC I', 'Atividades Complementares I'],
      8: ['Tópicos em Linguística', 'Eletiva IV', 'TCC II', 'Atividades Complementares II', 'Desenvolvimento Profissional'],
    },
  },
  {
    id: 'pedagogia',
    name: 'Pedagogia',
    sigla: 'PED',
    tipo: 'Licenciatura',
    semestres: 8,
    periodo: ['matutino', 'noturno'],
    subjects: {
      1: ['Fundamentos da Educação', 'Filosofia da Educação', 'Sociologia da Educação', 'Psicologia da Educação I', 'Didática I'],
      2: ['História da Educação', 'Psicologia da Educação II', 'Didática II', 'Alfabetização e Letramento', 'Libras'],
      3: ['Fundamentos da Educação Especial', 'Gestão Escolar I', 'Currículo e Avaliação', 'Literatura Infantil', 'Estágio Supervisionado I'],
      4: ['Educação de Jovens e Adultos', 'Gestão Escolar II', 'Educação Ambiental', 'Tecnologia na Educação', 'Estágio Supervisionado II'],
      5: ['Educação Infantil I', 'Metodologia do Ensino da Matemática', 'Política Educacional', 'Eletiva I', 'Estágio Supervisionado III'],
      6: ['Educação Infantil II', 'Metodologia do Ensino de Ciências', 'Pesquisa em Educação', 'Eletiva II', 'Estágio Supervisionado IV'],
      7: ['Educação Inclusiva', 'Eletiva III', 'TCC I', 'Atividades Complementares I', 'Prática Pedagógica I'],
      8: ['Tópicos em Educação', 'Eletiva IV', 'TCC II', 'Atividades Complementares II', 'Prática Pedagógica II'],
    },
  },
  {
    id: 'tec_inf_soc',
    name: 'Tecnologia da Informação e Comunicação Social',
    sigla: 'TEC INF SOC',
    tipo: 'Tecnólogo',
    semestres: 5,
    periodo: ['matutino', 'noturno'],
    subjects: {
      1: ['Fundamentos de Comunicação', 'Introdução às TIC', 'Produção de Conteúdo Digital', 'Fotografia e Imagem', 'Sociologia da Comunicação'],
      2: ['Jornalismo Digital', 'Design Gráfico', 'Redes Sociais e Mídias Digitais', 'Marketing Digital', 'Redação para Web'],
      3: ['Produção Audiovisual', 'Gestão de Projetos de Comunicação', 'Comunicação Corporativa', 'Análise de Dados para Comunicação', 'Ética em Comunicação'],
      4: ['Assessoria de Imprensa', 'Publicidade e Propaganda', 'Métricas e Analytics', 'Eletiva I', 'Estágio Supervisionado I'],
      5: ['Tendências em TIC', 'Empreendedorismo em Comunicação', 'Eletiva II', 'Estágio Supervisionado II', 'TCC'],
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
  if (diff < 1440) return `${Math.floor(diff/60)}h`;
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'short' });
}

function postTypeIcon(type) {
  return { aviso:'📢', documento:'📄', imagem:'🖼️', discussao:'💬', link:'🔗' }[type] || '💬';
}

// ── IA: Análise de imagem de grade curricular via Claude API ──────────────────

async function analyzeGradeImage(imageBase64, mimeType = 'image/jpeg') {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: imageBase64 },
            },
            {
              type: 'text',
              text: `Esta é uma imagem de grade curricular, histórico ou comprovante de matrícula de um estudante da FACAPE (Faculdade de Petrolina).
Extraia APENAS as matérias/disciplinas que o aluno está cursando AGORA (matrícula ativa ou semestre atual).
Retorne SOMENTE um JSON válido no formato:
{"materias": ["Nome Matéria 1", "Nome Matéria 2", ...], "semestre": 1, "curso": "Nome do Curso"}
Se não conseguir identificar claramente, retorne: {"materias": [], "semestre": null, "curso": null}
Não inclua texto fora do JSON.`,
            },
          ],
        }],
      }),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[turmas/ia] Erro ao analisar imagem:', err);
    return { materias: [], semestre: null, curso: null };
  }
}

// ── Perfil Acadêmico Completo (com matérias) ─────────────────────────────────

export async function loadFullAcademicProfile(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'profile', 'academic'));
    if (snap.exists()) return snap.data();
    return null;
  } catch { return null; }
}

export async function saveFullAcademicProfile(uid, data) {
  try {
    await setDoc(doc(db, 'users', uid, 'profile', 'academic'), {
      institution: data.institution || FACAPE_INSTITUTION,
      course:      data.course || '',
      courseId:    data.courseId || '',
      semester:    parseInt(data.semester) || 1,
      period:      data.period || 'noturno',
      subjects:    data.subjects || [],   // [{ name, code }]
      skills:      data.skills || [],
      bio:         data.bio || '',
      updatedAt:   new Date().toISOString(),
    }, { merge: true });

    // Atualiza user_profiles para busca pública
    await setDoc(doc(db, 'user_profiles', uid), {
      institution: data.institution || FACAPE_INSTITUTION,
      course:      data.course || '',
      courseId:    data.courseId || '',
    }, { merge: true });

    return true;
  } catch (err) {
    console.error('[turmas] Erro ao salvar perfil:', err);
    return false;
  }
}

// ── Salas de Matéria ──────────────────────────────────────────────────────────

function roomId(institution, subjectName, subjectCode) {
  const raw = `${institution}::${subjectCode || subjectName}`;
  return raw.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9:]/g, '_')
    .slice(0, 100);
}

export async function ensureSubjectRoom(institution, subjectName, subjectCode) {
  const id = roomId(institution, subjectName, subjectCode);
  const ref = doc(db, 'subject_rooms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      institution, subjectName,
      subjectCode: subjectCode || '',
      memberCount: 0,
      createdAt: serverTimestamp(),
    });
  }
  return id;
}

export async function joinSubjectRoom(roomId, uid) {
  try {
    await setDoc(doc(db, 'subject_rooms', roomId, 'members', uid), {
      uid, joinedAt: serverTimestamp(),
    });
    const snap = await getDoc(doc(db, 'subject_rooms', roomId));
    const cur = snap.data()?.memberCount || 0;
    await updateDoc(doc(db, 'subject_rooms', roomId), { memberCount: cur + 1 });
    return true;
  } catch (err) {
    console.error('[turmas] Erro ao entrar na sala:', err);
    return false;
  }
}

export async function leaveSubjectRoom(roomId, uid) {
  try {
    await deleteDoc(doc(db, 'subject_rooms', roomId, 'members', uid));
    const snap = await getDoc(doc(db, 'subject_rooms', roomId));
    const cur = snap.data()?.memberCount || 1;
    await updateDoc(doc(db, 'subject_rooms', roomId), { memberCount: Math.max(0, cur - 1) });
    return true;
  } catch { return false; }
}

export async function isRoomMember(roomId, uid) {
  try {
    const snap = await getDoc(doc(db, 'subject_rooms', roomId, 'members', uid));
    return snap.exists();
  } catch { return false; }
}

export async function syncUserRooms(uid, profile) {
  if (!profile?.institution || !profile?.subjects?.length) return;
  for (const sub of profile.subjects) {
    const rid = await ensureSubjectRoom(profile.institution, sub.name, sub.code);
    await joinSubjectRoom(rid, uid);
  }
}

export async function listMyRooms(uid) {
  const profile = await loadFullAcademicProfile(uid);
  if (!profile?.subjects?.length || !profile?.institution) return [];

  const rooms = [];
  for (const sub of profile.subjects) {
    const rid = roomId(profile.institution, sub.name, sub.code);
    try {
      const snap = await getDoc(doc(db, 'subject_rooms', rid));
      if (snap.exists()) {
        const isMember = await isRoomMember(rid, uid);
        rooms.push({ id: rid, ...snap.data(), isMember, subjectRef: sub });
      } else {
        await ensureSubjectRoom(profile.institution, sub.name, sub.code);
        await joinSubjectRoom(rid, uid);
        rooms.push({
          id: rid, institution: profile.institution,
          subjectName: sub.name, subjectCode: sub.code || '',
          memberCount: 1, isMember: true, subjectRef: sub,
        });
      }
    } catch { /* ignora salas que falharam */ }
  }
  return rooms;
}

// ── Posts do Mural ────────────────────────────────────────────────────────────

export async function postToMural(roomId, { type, content, fileUrl, fileName, fileType }) {
  const user = auth.currentUser;
  if (!user || !content?.trim()) return null;
  try {
    const ref = await addDoc(collection(db, 'subject_rooms', roomId, 'posts'), {
      authorId:   user.uid,
      authorName: user.displayName || user.email.split('@')[0],
      type:       type || 'discussao',
      content:    content.trim(),
      fileUrl:    fileUrl || null,
      fileName:   fileName || null,
      fileType:   fileType || null,
      likes:      [],
      createdAt:  serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('[turmas] Erro ao postar:', err);
    return null;
  }
}

export async function deletePost(roomId, postId, uid) {
  try {
    const ref = doc(db, 'subject_rooms', roomId, 'posts', postId);
    const snap = await getDoc(ref);
    if (!snap.exists() || snap.data().authorId !== uid) return false;
    await deleteDoc(ref);
    return true;
  } catch { return false; }
}

export async function toggleLikePost(roomId, postId, uid) {
  try {
    const ref = doc(db, 'subject_rooms', roomId, 'posts', postId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const likes = snap.data().likes || [];
    if (likes.includes(uid)) {
      await updateDoc(ref, { likes: arrayRemove(uid) });
    } else {
      await updateDoc(ref, { likes: arrayUnion(uid) });
    }
  } catch (err) { console.error('[turmas] Erro ao curtir:', err); }
}

// ── Listener em Tempo Real do Mural ──────────────────────────────────────────

export function subscribeMural(roomId, callback) {
  if (_unsubMural) { _unsubMural(); _unsubMural = null; }
  _currentRoomId = roomId;
  const q = query(
    collection(db, 'subject_rooms', roomId, 'posts'),
    orderBy('createdAt', 'desc'),
    limit(50)
  );
  _unsubMural = onSnapshot(q, (snap) => {
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(posts);
  }, (err) => {
    console.error('[turmas] Erro no listener do mural:', err);
    callback(null, err);
  });
  return () => { if (_unsubMural) { _unsubMural(); _unsubMural = null; } };
}

// ── Renderização da aba Turmas ────────────────────────────────────────────────

export async function renderTurmasTab(uid) {
  const container = document.getElementById('turmas-tab-content');
  if (!container) return;

  const profile = await loadFullAcademicProfile(uid);

  if (!profile?.institution || !profile?.subjects?.length) {
    renderOnboarding(container, uid);
    return;
  }

  container.innerHTML = `
    <div class="turmas-profile-bar">
      <div class="turmas-profile-info">
        <span class="turmas-inst">${esc(FACAPE_DISPLAY_NAME)}</span>
        <span class="turmas-course">${esc(profile.course)} · ${profile.semester}º sem · ${esc(profile.period || 'noturno')}</span>
      </div>
      <button class="turmas-edit-btn" onclick="window.openTurmasOnboarding()">✏️ Editar</button>
    </div>
    <div class="turmas-rooms-list" id="turmas-rooms-list">
      <div class="turmas-loading">⏳ Carregando suas turmas...</div>
    </div>
  `;

  const rooms = await listMyRooms(uid);
  const listEl = document.getElementById('turmas-rooms-list');
  if (!listEl) return;

  if (!rooms.length) {
    listEl.innerHTML = `<div class="turmas-empty">Nenhuma turma encontrada. <button onclick="window.openTurmasOnboarding()">Adicionar matérias</button></div>`;
    return;
  }

  listEl.innerHTML = rooms.map(room => `
    <div class="turma-card" onclick="window.openMural('${room.id}', '${esc(room.subjectName)}')">
      <div class="turma-card-left">
        <div class="turma-card-icon">📚</div>
        <div class="turma-card-info">
          <span class="turma-card-name">${esc(room.subjectName)}</span>
          ${room.subjectCode ? `<span class="turma-card-code">${esc(room.subjectCode)}</span>` : ''}
          <span class="turma-card-members">👥 ${room.memberCount || 1} aluno${(room.memberCount||1) !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="turma-card-arrow">›</div>
    </div>
  `).join('');
}

// ── Onboarding FACAPE: seleção de curso + matérias ────────────────────────────

function renderOnboarding(container, uid) {
  container.innerHTML = `
    <div class="turmas-onboarding">
      <div class="turmas-onboarding-icon">🎓</div>
      <h3 class="turmas-onboarding-title">Configure seu Perfil Acadêmico</h3>
      <p class="turmas-onboarding-desc">Informe sua faculdade e matérias para interagir com seus colegas de turma.</p>
      <button class="btn-primary turmas-onboarding-btn" onclick="window.openTurmasOnboarding()">
        Configurar agora
      </button>
    </div>
  `;
}

window.openTurmasOnboarding = async function() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const profile = await loadFullAcademicProfile(uid) || {};

  // Gera opções de cursos
  const courseOptions = FACAPE_COURSES.map(c =>
    `<option value="${c.id}" ${profile.courseId === c.id ? 'selected' : ''}>${c.name} (${c.tipo})</option>`
  ).join('');

  openModal('🎓 Perfil Acadêmico', `
    <div class="turmas-form">

      <!-- Instituição fixa: FACAPE -->
      <div class="form-group">
        <label class="form-label">Instituição de Ensino</label>
        <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--bg-secondary,#1a1a2e);border-radius:8px;border:1px solid var(--border,#333)">
          <span style="font-size:18px">🏛️</span>
          <div>
            <div style="font-weight:600;color:var(--text)">${FACAPE_DISPLAY_NAME}</div>
            <div style="font-size:12px;color:var(--text-muted)">Petrolina – PE</div>
          </div>
        </div>
      </div>

      <!-- Seleção de curso -->
      <div class="form-group">
        <label class="form-label">Curso *</label>
        <select id="ta-course-id" class="form-select" onchange="window._taOnCourseChange()">
          <option value="">Selecione seu curso...</option>
          ${courseOptions}
        </select>
      </div>

      <!-- Semestre e Período -->
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Semestre</label>
          <input id="ta-semester" class="form-input" type="number" min="1" max="10" value="${profile.semester || 1}">
        </div>
        <div class="form-group">
          <label class="form-label">Período</label>
          <select id="ta-period" class="form-select">
            <option value="matutino" ${profile.period === 'matutino' ? 'selected' : ''}>Matutino</option>
            <option value="vespertino" ${profile.period === 'vespertino' ? 'selected' : ''}>Vespertino</option>
            <option value="noturno" ${(profile.period === 'noturno' || !profile.period) ? 'selected' : ''}>Noturno</option>
            <option value="integral" ${profile.period === 'integral' ? 'selected' : ''}>Integral</option>
            <option value="ead" ${profile.period === 'ead' ? 'selected' : ''}>EaD</option>
          </select>
        </div>
      </div>

      <!-- IA: Upload de grade curricular -->
      <div class="form-group">
        <label class="form-label">📸 Importar Grade pelo Portal (IA)</label>
        <div class="turmas-ia-upload" id="ta-ia-upload-area">
          <label for="ta-grade-img" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px">
            <span style="font-size:28px">🤖</span>
            <span style="font-weight:600;color:var(--accent)">Enviar print do portal aluno</span>
            <span style="font-size:12px;color:var(--text-muted);text-align:center">A IA vai identificar automaticamente suas matérias do portal.facape.br</span>
            <input type="file" id="ta-grade-img" accept="image/*" style="display:none" onchange="window._taAnalyzeImage()">
          </label>
        </div>
        <div id="ta-ia-status" style="margin-top:6px;font-size:13px;color:var(--accent);display:none"></div>
      </div>

      <!-- Matérias selecionadas -->
      <div class="form-group">
        <label class="form-label">Minhas Matérias</label>

        <!-- Matérias do semestre (baseado no curso) -->
        <div id="ta-semester-subjects" class="turmas-semester-subjects" style="margin-bottom:8px"></div>

        <!-- Lista de selecionadas -->
        <div class="turmas-subjects-list" id="ta-subjects-list"></div>

        <!-- Adicionar manualmente -->
        <div class="turmas-add-subject" style="margin-top:8px">
          <input id="ta-sub-name" class="form-input" placeholder="Adicionar matéria manualmente" style="flex:2">
          <button class="btn-secondary" onclick="window._taAddSubject()" style="white-space:nowrap">+ Adicionar</button>
        </div>
      </div>

      <button class="btn-primary" onclick="window._taSave()" style="width:100%;margin-top:8px">
        💾 Salvar e Entrar nas Turmas
      </button>
    </div>
  `);

  // Estado interno das matérias
  let subjects = profile.subjects ? [...profile.subjects] : [];
  renderSubjectChips();

  // Se já tem curso selecionado, renderiza as matérias do semestre
  if (profile.courseId) {
    window._taOnCourseChange();
  }

  // ── Handlers internos ─────────────────────────────────────────────────────

  window._taOnCourseChange = function() {
    const courseId = document.getElementById('ta-course-id')?.value;
    const semester = parseInt(document.getElementById('ta-semester')?.value) || 1;
    if (!courseId) {
      const el = document.getElementById('ta-semester-subjects');
      if (el) el.innerHTML = '';
      return;
    }
    const course = FACAPE_COURSES.find(c => c.id === courseId);
    if (!course) return;
    renderSemesterSubjects(course, semester);
  };

  // Também atualiza ao mudar semestre
  document.getElementById('ta-semester')?.addEventListener('change', () => {
    window._taOnCourseChange();
  });

  function renderSemesterSubjects(course, semester) {
    const el = document.getElementById('ta-semester-subjects');
    if (!el) return;
    const subs = course.subjects[semester] || [];
    if (!subs.length) { el.innerHTML = ''; return; }

    el.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">
        Matérias do ${semester}º semestre de ${course.name} — clique para adicionar:
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${subs.map(s => `
          <button class="turmas-quick-sub-btn" onclick="window._taQuickAdd('${esc(s)}')"
            style="padding:4px 10px;border-radius:20px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;font-size:12px;transition:all .15s"
            title="Clique para adicionar">${esc(s)}</button>
        `).join('')}
      </div>
      <button onclick="window._taAddAllSemester()" style="margin-top:8px;font-size:12px;padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-muted);cursor:pointer">
        ➕ Adicionar todas do semestre
      </button>
    `;
  }

  window._taQuickAdd = function(name) {
    if (subjects.find(s => s.name.toLowerCase() === name.toLowerCase())) {
      showToast('Matéria já adicionada'); return;
    }
    subjects.push({ name, code: '' });
    renderSubjectChips();
  };

  window._taAddAllSemester = function() {
    const courseId = document.getElementById('ta-course-id')?.value;
    const semester = parseInt(document.getElementById('ta-semester')?.value) || 1;
    const course = FACAPE_COURSES.find(c => c.id === courseId);
    if (!course) return;
    const subs = course.subjects[semester] || [];
    let added = 0;
    subs.forEach(name => {
      if (!subjects.find(s => s.name.toLowerCase() === name.toLowerCase())) {
        subjects.push({ name, code: '' });
        added++;
      }
    });
    renderSubjectChips();
    if (added) showToast(`✅ ${added} matéria(s) adicionada(s)`);
  };

  // ── IA: Análise da imagem do portal ───────────────────────────────────────
  window._taAnalyzeImage = async function() {
    const fileInput = document.getElementById('ta-grade-img');
    const file = fileInput?.files?.[0];
    if (!file) return;

    const statusEl = document.getElementById('ta-ia-status');
    const uploadArea = document.getElementById('ta-ia-upload-area');
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '🤖 Analisando imagem com IA...'; }
    if (uploadArea) uploadArea.style.opacity = '0.5';

    // Converte para base64
    const base64 = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result.split(',')[1]);
      reader.onerror = () => rej(new Error('Falha ao ler imagem'));
      reader.readAsDataURL(file);
    });

    const mimeType = file.type || 'image/jpeg';
    const result = await analyzeGradeImage(base64, mimeType);

    if (uploadArea) uploadArea.style.opacity = '1';

    if (!result.materias?.length) {
      if (statusEl) statusEl.textContent = '❌ Não foi possível identificar matérias. Tente outra imagem ou adicione manualmente.';
      return;
    }

    // Preenche automaticamente curso e semestre se detectados
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
    if (result.semestre) {
      const semInput = document.getElementById('ta-semester');
      if (semInput) semInput.value = result.semestre;
    }

    // Adiciona matérias detectadas
    let added = 0;
    result.materias.forEach(name => {
      if (!subjects.find(s => s.name.toLowerCase() === name.toLowerCase())) {
        subjects.push({ name: name.trim(), code: '' });
        added++;
      }
    });

    renderSubjectChips();
    window._taOnCourseChange();

    if (statusEl) statusEl.textContent = `✅ ${added} matéria(s) identificada(s) pela IA! Revise e ajuste se necessário.`;
    showToast(`🤖 IA encontrou ${added} matéria(s)!`);
  };

  function renderSubjectChips() {
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
    if (document.getElementById('ta-sub-name')) document.getElementById('ta-sub-name').value = '';
    renderSubjectChips();
  };

  window._taRemoveSubject = function(idx) {
    subjects.splice(idx, 1);
    renderSubjectChips();
  };

  window._taSave = async function() {
    const courseId = document.getElementById('ta-course-id')?.value;
    const semester = parseInt(document.getElementById('ta-semester')?.value) || 1;
    const period = document.getElementById('ta-period')?.value || 'noturno';

    if (!courseId) { showToast('Selecione seu curso'); return; }
    if (!subjects.length) { showToast('Adicione pelo menos uma matéria'); return; }

    const course = FACAPE_COURSES.find(c => c.id === courseId);
    const courseName = course?.name || courseId;

    const btn = document.querySelector('button[onclick="window._taSave()"]');
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

    await syncUserRooms(uid, { institution: FACAPE_INSTITUTION, subjects });

    closeModal();
    showToast('✅ Perfil acadêmico salvo! Entrando nas turmas...');
    const container = document.getElementById('turmas-tab-content');
    if (container) await renderTurmasTab(uid);
  };
};

// ── Mural de uma matéria ──────────────────────────────────────────────────────

window.openMural = async function(roomId, subjectName) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  openModal(`📚 ${subjectName}`, `
    <div class="mural-container">
      <div class="mural-new-post">
        <select id="mural-type" class="form-select mural-type-sel">
          <option value="discussao">💬 Discussão</option>
          <option value="aviso">📢 Aviso</option>
          <option value="link">🔗 Link</option>
          <option value="documento">📄 Documento (link)</option>
          <option value="imagem">🖼️ Imagem (link)</option>
        </select>
        <textarea id="mural-content" class="form-textarea mural-textarea" placeholder="Escreva um aviso, compartilhe um link ou inicie uma discussão..." rows="3"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-primary" onclick="window._muralPost('${roomId}')">Publicar</button>
        </div>
      </div>
      <div id="mural-posts-list" class="mural-posts-list">
        <div class="turmas-loading">⏳ Carregando mural...</div>
      </div>
    </div>
  `);

  subscribeMural(roomId, (posts, err) => {
    const listEl = document.getElementById('mural-posts-list');
    if (!listEl) return;
    if (err || !posts) {
      listEl.innerHTML = `<div class="turmas-empty">Erro ao carregar o mural. Verifique sua conexão.</div>`;
      return;
    }
    if (!posts.length) {
      listEl.innerHTML = `<div class="mural-empty">Nenhuma publicação ainda. Seja o primeiro! 🚀</div>`;
      return;
    }
    listEl.innerHTML = posts.map(p => renderMuralPost(p, uid, roomId)).join('');
  });
};

function renderMuralPost(post, uid, roomId) {
  const isOwn = post.authorId === uid;
  const likes = (post.likes || []).length;
  const liked = (post.likes || []).includes(uid);
  const avatar = (post.authorName || 'A')[0].toUpperCase();

  const typeColors = {
    aviso: '#ff6b35',
    documento: '#1e90ff',
    imagem: '#2ed573',
    link: '#a29bfe',
    discussao: 'var(--accent)',
  };
  const color = typeColors[post.type] || 'var(--accent)';

  let extra = '';
  if (post.fileUrl) {
    if (post.fileType === 'imagem' || post.type === 'imagem') {
      extra = `<img src="${esc(post.fileUrl)}" alt="imagem" class="mural-post-img" onerror="this.style.display='none'">`;
    } else if (post.type === 'link' || post.type === 'documento') {
      extra = `<a href="${esc(post.fileUrl)}" target="_blank" rel="noopener" class="mural-post-link">
        📎 ${esc(post.fileName || post.fileUrl)}
      </a>`;
    }
  }

  const contentWithLinks = esc(post.content).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener" class="mural-inline-link">$1</a>'
  );

  return `
    <div class="mural-post" id="mpost-${post.id}">
      <div class="mural-post-header">
        <div class="mural-post-avatar">${avatar}</div>
        <div class="mural-post-meta">
          <span class="mural-post-author">${esc(post.authorName)}</span>
          <div class="mural-post-badges">
            <span class="mural-post-type-badge" style="background:${color}22;color:${color}">
              ${postTypeIcon(post.type)} ${esc(post.type)}
            </span>
            <span class="mural-post-time">${fmtDate(post.createdAt)}</span>
          </div>
        </div>
        ${isOwn ? `<button class="mural-del-btn" onclick="window._muralDelete('${roomId}','${post.id}')" title="Excluir">🗑️</button>` : ''}
      </div>
      <div class="mural-post-content">${contentWithLinks}</div>
      ${extra}
      <div class="mural-post-actions">
        <button class="mural-like-btn ${liked ? 'liked' : ''}" onclick="window._muralLike('${roomId}','${post.id}')">
          ${liked ? '❤️' : '🤍'} ${likes}
        </button>
      </div>
    </div>
  `;
}

window._muralPost = async function(roomId) {
  const content = document.getElementById('mural-content')?.value?.trim();
  const type = document.getElementById('mural-type')?.value || 'discussao';
  if (!content) { showToast('Escreva algo antes de publicar'); return; }

  const btn = document.querySelector('button[onclick*="_muralPost"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Publicando...'; }

  let fileUrl = null, fileName = null;
  const urlMatch = content.match(/https?:\/\/[^\s]+/);
  if ((type === 'link' || type === 'documento' || type === 'imagem') && urlMatch) {
    fileUrl = urlMatch[0];
    fileName = fileUrl.split('/').pop().split('?')[0] || fileUrl;
  }

  const id = await postToMural(roomId, { type, content, fileUrl, fileName });
  if (btn) { btn.disabled = false; btn.textContent = 'Publicar'; }
  if (id) {
    const ta = document.getElementById('mural-content');
    if (ta) ta.value = '';
    showToast('✅ Publicado no mural!');
  } else {
    showToast('Erro ao publicar. Tente novamente.');
  }
};

window._muralDelete = async function(roomId, postId) {
  if (!confirm('Excluir esta publicação?')) return;
  const uid = auth.currentUser?.uid;
  const ok = await deletePost(roomId, postId, uid);
  if (!ok) showToast('Não foi possível excluir.');
};

window._muralLike = async function(roomId, postId) {
  const uid = auth.currentUser?.uid;
  if (!uid) { showToast('Faça login para curtir'); return; }
  await toggleLikePost(roomId, postId, uid);
};

// ── CSS adicional injetado (estilos para upload IA e quick-add) ───────────────

(function injectTurmasExtraStyles() {
  if (document.getElementById('turmas-extra-styles')) return;
  const style = document.createElement('style');
  style.id = 'turmas-extra-styles';
  style.textContent = `
    .turmas-ia-upload {
      border: 2px dashed var(--accent, #7c5cfc);
      border-radius: 10px;
      background: rgba(124, 92, 252, 0.05);
      transition: background 0.2s;
    }
    .turmas-ia-upload:hover {
      background: rgba(124, 92, 252, 0.1);
    }
    .turmas-semester-subjects {
      padding: 10px;
      background: var(--bg-secondary, #1a1a2e);
      border-radius: 8px;
      border: 1px solid var(--border, #333);
    }
    .turmas-quick-sub-btn:hover {
      background: var(--accent, #7c5cfc) !important;
      color: #fff !important;
    }
  `;
  document.head.appendChild(style);
})();

// ── Inicialização ─────────────────────────────────────────────────────────────

export function initTurmas() {
  injectTurmasExtraStylesIfNeeded();
  const modalOverlay = document.getElementById('modal-overlay');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', () => {
      if (_unsubMural) { _unsubMural(); _unsubMural = null; _currentRoomId = null; }
    });
  }
}

function injectTurmasExtraStylesIfNeeded() {
  if (!document.getElementById('turmas-extra-styles')) {
    const style = document.createElement('style');
    style.id = 'turmas-extra-styles';
    style.textContent = `
      .turmas-ia-upload { border:2px dashed var(--accent,#7c5cfc); border-radius:10px; background:rgba(124,92,252,.05); transition:background .2s; }
      .turmas-ia-upload:hover { background:rgba(124,92,252,.1); }
      .turmas-semester-subjects { padding:10px; background:var(--bg-secondary,#1a1a2e); border-radius:8px; border:1px solid var(--border,#333); }
      .turmas-quick-sub-btn:hover { background:var(--accent,#7c5cfc)!important; color:#fff!important; }
    `;
    document.head.appendChild(style);
  }
}