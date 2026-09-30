// ============================================================
// judo-store.js  —  MOTOR DE CHAVEAMENTO (camada invisível)
//
// Esta é a ÚNICA camada que conhece as regras de cada tipo de
// chaveamento (melhor de 3 / rodízio / mata-mata) e a ÚNICA que
// pode alterar o resultado de uma luta. Nem a tela de
// visualização (chaveamento.html) nem a de áreas (area.html)
// implementam essas regras — elas só leem dados ou chamam
// atualizarResultado().
//
// Armazenamento: localStorage (compartilhado entre abas).
// ============================================================

const STORE_KEYS = {
  CATEGORIAS: "categorias_db",
  LUTAS: "lutas_db",
  AREAS: "areas_db",
  NUM_AREAS: "numAreas",
  CATEGORIA_ATUAL: "categoriaAtual",
  AREA_ATUAL: "areaAtual"
};

// ============================================================
// CAMADA FIREBASE — substitui o localStorage para categorias,
// lutas e áreas. O resto do motor continua igual.
// ============================================================
const COLECOES = {
  [STORE_KEYS.CATEGORIAS]: "categorias",
  [STORE_KEYS.LUTAS]:      "lutas",
  [STORE_KEYS.AREAS]:      "areas"
};

// cache em memória, mantido em tempo real pelos listeners
const _cache = {
  [STORE_KEYS.CATEGORIAS]: [],
  [STORE_KEYS.LUTAS]: [],
  [STORE_KEYS.AREAS]: []
};

const _ouvintes = [];

function _clonar(x) { return JSON.parse(JSON.stringify(x)); }

function _notificar(key) {
  _ouvintes.forEach(fn => { try { fn(key); } catch (e) { console.error(e); } });
}

// Leitura: devolve uma CÓPIA do cache (o motor altera o array e depois
// chama save*, então precisa ser uma cópia para o diff funcionar).
function _get(key, def) {
  if (COLECOES[key]) return _clonar(_cache[key]);

  // chaves locais do dispositivo (numAreas, categoriaAtual, areaAtual)
  let raw = localStorage.getItem(key);
  if (!raw) return def;
  try { return JSON.parse(raw); } catch (e) { return def; }
}

// Escrita: atualiza o cache na hora e grava no Firestore SOMENTE os
// documentos que mudaram (assim dois celulares finalizando lutas
// diferentes não sobrescrevem um ao outro).
function _set(key, value) {
  if (!COLECOES[key]) {
    localStorage.setItem(key, JSON.stringify(value));
    return;
  }

  let antiga = _cache[key];
  let antigaPorId = new Map(antiga.map(x => [x.id, x]));
  let novaIds = new Set(value.map(x => x.id));
  let col = db.collection(COLECOES[key]);
  let batch = db.batch();
  let mudou = false;

  value.forEach(item => {
    let velho = antigaPorId.get(item.id);
    if (!velho || JSON.stringify(velho) !== JSON.stringify(item)) {
      batch.set(col.doc(String(item.id)), item);
      mudou = true;
    }
  });

  antiga.forEach(velho => {
    if (!novaIds.has(velho.id)) {
      batch.delete(col.doc(String(velho.id)));
      mudou = true;
    }
  });

  _cache[key] = _clonar(value).sort((a, b) => a.id - b.id);

  if (mudou) {
    batch.commit().catch(err => console.error("Erro ao salvar no Firebase:", err));
  }
}

// Inicia os listeners em tempo real. Retorna uma Promise que resolve
// quando as 3 coleções foram carregadas pela primeira vez.
// Toda página deve chamar (e aguardar) isto antes de renderizar.
let _storePronto = null;
function iniciarStore() {
  if (_storePronto) return _storePronto;

  _storePronto = new Promise(resolve => {
    let carregadas = 0;

    Object.keys(COLECOES).forEach(key => {
      let primeira = true;

      db.collection(COLECOES[key]).onSnapshot(snap => {
        _cache[key] = snap.docs.map(d => d.data()).sort((a, b) => a.id - b.id);

        if (primeira) {
          primeira = false;
          carregadas++;
          if (carregadas === Object.keys(COLECOES).length) resolve();
        } else {
          _notificar(key); // mudança vinda de qualquer dispositivo
        }
      }, err => console.error("Erro no listener:", err));
    });
  });

  return _storePronto;
}

// Registra um callback chamado a cada atualização em tempo real.
// Recebe a chave alterada (STORE_KEYS.LUTAS, .AREAS ou .CATEGORIAS).
// Retorna uma função para cancelar a escuta.
function onStoreUpdate(callback) {
  _ouvintes.push(callback);
  return () => {
    let i = _ouvintes.indexOf(callback);
    if (i >= 0) _ouvintes.splice(i, 1);
  };
}

// Substitui os localStorage.removeItem do resetarSistema()
async function resetarCampeonato() {
  console.log("[reset] iniciando...");
  for (const nome of Object.values(COLECOES)) {
    // source: "server" força ler do servidor (e dá erro claro se estiver
    // sem conexão), em vez de apagar só o que estava no cache local
    let snap = await db.collection(nome).get({ source: "server" });
    console.log(`[reset] ${nome}: ${snap.size} documento(s) no servidor`);

    let docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      let batch = db.batch();
      docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    console.log(`[reset] ${nome}: apagada`);
  }
  console.log("[reset] concluído");
}

function proximoId(lista) {
  if (!lista.length) return 1;
  return Math.max(...lista.map(x => x.id)) + 1;
}

// ================= CATEGORIAS =================
// { id, nome, atletas, tipo, tabela? , finalizada, resultadoFinal }

function getCategorias() { return _get(STORE_KEYS.CATEGORIAS, []); }
function saveCategorias(cs) { _set(STORE_KEYS.CATEGORIAS, cs); }
function getCategoriaPorId(id) {
  return getCategorias().find(c => c.id === id) || null;
}

function tipoChaveamento(n) {
  if (n === 2) return "melhorDe3";
  if (n >= 3 && n <= 5) return "rodizio";
  return "mataMata";
}

// Cria a categoria (com id, tipo e tabela quando aplicável) e já gera
// as lutas iniciais dela. Ponto único de entrada usado pela tela de
// categorias — o motor decide tudo mais.
function criarCategoriaCompleta(nome, atletas) {
  let categoriasSalvas = getCategorias();
  let id = proximoId(categoriasSalvas);
  let tipo = tipoChaveamento(atletas.length);

  let categoria = {
    id: id,
    nome: nome,
    atletas: atletas,
    tipo: tipo,
    finalizada: false,
    resultadoFinal: null // { campeao, vice, terceiro } quando finalizada
  };

  if (tipo === "rodizio") {
    let tabela = {};
    atletas.forEach(a => tabela[a] = { pontos: 0, vitorias: 0 });
    categoria.tabela = tabela;
  }

  categoriasSalvas.push(categoria);
  saveCategorias(categoriasSalvas);

  let lutasGeradas = gerarLutasCategoria(categoria);

  return { categoria, lutasGeradas };
}

// ================= LUTAS (objeto único compartilhado) =================
// { id, categoriaId, tipo, fase, posicao, atletaA, atletaB,
//   vencedor, tipoVitoria, status, proximaLutaId }
//
// status: "pendente" | "finalizada" | "cancelada"
// proximaLutaId: preenchido automaticamente quando o chaveamento avança

function getLutas() { return _get(STORE_KEYS.LUTAS, []); }
function saveLutas(ls) { _set(STORE_KEYS.LUTAS, ls); }
function getLutaPorId(id) {
  return getLutas().find(l => l.id === id) || null;
}
function getLutasPorCategoria(categoriaId) {
  return getLutas().filter(l => l.categoriaId === categoriaId);
}

function criarLuta(categoriaId, atletaA, atletaB, extra = {}) {
  let lutas = getLutas();
  let luta = Object.assign({
    id: proximoId(lutas),
    categoriaId: categoriaId,
    atletaA: atletaA,
    atletaB: atletaB,
    vencedor: null,
    tipoVitoria: null,
    status: "pendente",
    tipo: null,
    fase: null,
    posicao: null,
    proximaLutaId: null
  }, extra);
  lutas.push(luta);
  saveLutas(lutas);
  return luta;
}

// ================= GERAÇÃO INICIAL DE LUTAS POR TIPO =================
// Só o PAREAMENTO inicial. Para mata-mata, gera apenas a 1ª fase — as
// fases seguintes são geradas automaticamente por atualizarResultado().
function gerarLutasCategoria(categoria) {
  let atletas = categoria.atletas;
  let tipo = categoria.tipo;
  let lutasGeradas = [];

  if (tipo === "melhorDe3") {
    let [a, b] = atletas;
    for (let i = 0; i < 3; i++) {
      lutasGeradas.push(criarLuta(categoria.id, a, b, {
        tipo: "melhorDe3", fase: i + 1, posicao: 0
      }));
    }
  }

  else if (tipo === "rodizio") {
    let lista = [...atletas];
    if (lista.length % 2 !== 0) lista.push("BYE");
    let n2 = lista.length;

    for (let r = 0; r < n2 - 1; r++) {
      let posicao = 0;
      for (let i = 0; i < n2 / 2; i++) {
        let a = lista[i];
        let b = lista[n2 - 1 - i];
        if (a !== "BYE" && b !== "BYE") {
          lutasGeradas.push(criarLuta(categoria.id, a, b, {
            tipo: "rodizio", fase: r + 1, posicao: posicao
          }));
          posicao++;
        }
      }
      lista.splice(1, 0, lista.pop());
    }
  }

  else {
    let posicao = 0;
    for (let i = 0; i < atletas.length; i += 2) {
      let a = atletas[i];
      let b = atletas[i + 1] || "BYE";
      lutasGeradas.push(criarLuta(categoria.id, a, b, {
        tipo: "mataMata", fase: 1, posicao: posicao
      }));
      posicao++;
    }
  }

  return lutasGeradas;
}

function pontosPorTipo(tipoVitoria) {
  if (tipoVitoria === "ippon") return 10;
  if (tipoVitoria === "waza") return 5;
  if (tipoVitoria === "yuko") return 1;
  return 0;
}

// ================= ÁREAS (TATAMES) =================
// { id, lutas: [idsDeLuta] } — áreas só REFERENCIAM lutas, nunca copiam.

function getAreas() { return _get(STORE_KEYS.AREAS, []); }
function saveAreas(as) { _set(STORE_KEYS.AREAS, as); }

function configurarAreas(qtd) {
  let areas = [];
  for (let i = 1; i <= qtd; i++) areas.push({ id: i, lutas: [] });
  saveAreas(areas);
  _set(STORE_KEYS.NUM_AREAS, qtd);
  return areas;
}

// Distribui uma lista de lutas (objetos ou ids) entre as áreas,
// alternando. Usada apenas na distribuição INICIAL das lutas de
// uma categoria recém-criada.


function distribuirLutas(lutas) {
  let areas = getAreas();
  if (!areas.length) return;

  let todasLutas = getLutas();

  // 🔹 transforma tudo em objeto completo (aceita IDs ou objetos) e
  // garante que cada luta resolvida realmente tem os dois atletas
  let lutasCompletas = lutas
    .map(l => (typeof l === "object" ? l : todasLutas.find(x => x.id === l)))
    .filter(l => l && l.atletaA && l.atletaB);

  if (!lutasCompletas.length) return;

  // 🔹 ordena para minimizar repetição sequencial de atletas
  let lutasOrdenadas = ordenarFilaInteligente(lutasCompletas);

  // 🔹 agrupa em RODADAS GLOBAIS: dentro de uma mesma rodada, nenhum
  // atleta se repete (ver agruparRodadasGlobais)
  let rodadas = agruparRodadasGlobais(lutasOrdenadas);

  // 🔹 CORREÇÃO PRINCIPAL DO BUG:
  // o índice de área é reiniciado a cada rodada (em vez de um contador
  // global contínuo). Isso é o que garante que lutas que precisam ficar
  // em rodadas SEPARADAS por compartilharem atleta — como as 3 lutas de
  // um "melhor de 3", que sempre envolvem o mesmo par e por isso nunca
  // cabem na mesma rodada — caiam sempre na MESMA sequência de áreas
  // (tipicamente a área 1), em vez de serem espalhadas por áreas
  // diferentes e correrem o risco de "acontecer" ao mesmo tempo.
  // Dentro de uma única rodada, como não há atleta repetido, distribuir
  // por índice (`% areas.length`) entre áreas diferentes é seguro.
    // 🔹 BALANCEAMENTO DE CARGA:
  // a escolha da área não usa mais índice/módulo. Para cada luta, a
  // luta vai para a área que tem MENOS lutas naquele momento.
  // Como cada luta é inserida na hora, a contagem é atualizada a cada
  // iteração e o balanceamento vale também entre rodadas e entre
  // categorias (o total já existente em cada área é considerado).

    rodadas.forEach(rodada => {
    rodada.forEach(luta => {
      if (areas.some(a => a.lutas.includes(luta.id))) return;

      let areaDestino = null;

      // melhor de 3: mantém a série na mesma área da 1ª luta já distribuída
      if (luta.tipo === "melhorDe3") {
        let idsDaSerie = getLutas()
          .filter(l => l.categoriaId === luta.categoriaId && l.tipo === "melhorDe3")
          .map(l => l.id);
        areaDestino = areas.find(a => a.lutas.some(id => idsDaSerie.includes(id))) || null;
      }

      // demais casos: área com MENOS lutas
      if (!areaDestino) {
        areaDestino = areas.reduce((menor, atual) =>
          atual.lutas.length < menor.lutas.length ? atual : menor
        );
      }

      areaDestino.lutas.push(luta.id);
    });
  });

  saveAreas(areas);
}

// Distribui TODAS as lutas pendentes que ainda não estão em nenhuma área.
// Só deve ser chamada pelo botão "Distribuir Campeonato".
// É idempotente: se clicar de novo, só distribui o que ainda não foi
// distribuído (ex.: categorias criadas depois).
// Retorna a quantidade de lutas distribuídas (ou -1 se não há áreas).
function distribuirCampeonato() {
  let areas = getAreas();
  if (!areas.length) return -1;

  let jaDistribuidas = new Set();
  areas.forEach(a => a.lutas.forEach(id => jaDistribuidas.add(id)));

  let pendentes = getLutas().filter(
    l => l.status === "pendente" && !jaDistribuidas.has(l.id)
  );

  if (!pendentes.length) return 0;

  distribuirLutas(pendentes);
  return pendentes.length;
}

function getAreaPorId(id) {
  return getAreas().find(a => a.id === id) || null;
}

function getAreaDaLuta(lutaId) {
  return getAreas().find(a => a.lutas.includes(lutaId)) || null;
}

function ordenarFilaInteligente(lutas) {
  let fila = [];
  let pendentes = [...lutas];

  let ultimoAtletaA = null;
  let ultimoAtletaB = null;

  while (pendentes.length > 0) {

    // tenta achar luta sem repetir atleta
    let index = pendentes.findIndex(luta => {
      return (
        luta.atletaA !== ultimoAtletaA &&
        luta.atletaA !== ultimoAtletaB &&
        luta.atletaB !== ultimoAtletaA &&
        luta.atletaB !== ultimoAtletaB
      );
    });

    // se não achar, pega a primeira mesmo
    if (index === -1) index = 0;

    let luta = pendentes.splice(index, 1)[0];

    fila.push(luta);

    ultimoAtletaA = luta.atletaA;
    ultimoAtletaB = luta.atletaB;
  }

  return fila;
}

function agruparRodadasGlobais(lutas) {
  let pendentes = [...lutas];
  let rodadas = [];

  while (pendentes.length > 0) {
    let rodada = [];
    let usados = new Set();

    for (let i = 0; i < pendentes.length; i++) {
      let luta = pendentes[i];

      if (
        !usados.has(luta.atletaA) &&
        !usados.has(luta.atletaB)
      ) {
        rodada.push(luta);
        usados.add(luta.atletaA);
        usados.add(luta.atletaB);

        pendentes.splice(i, 1);
        i--;
      }
    }

    rodadas.push(rodada);
  }

  return rodadas;
}

function adicionarLutaNaArea(areaId, lutaId) {
  let areas = getAreas();
  let area = areas.find(a => a.id === areaId);
  if (!area) return;
  if (!area.lutas.includes(lutaId)) area.lutas.push(lutaId);
  saveAreas(areas);
}

// Retorna os objetos de luta COMPLETOS e sempre atualizados de uma
// área, na ordem da fila (resolve ids -> dados reais em "lutas_db").
function getLutasDaArea(areaId) {
  let area = getAreaPorId(areaId);
  if (!area) return [];
  let lutas = getLutas();
  return area.lutas.map(id => lutas.find(l => l.id === id)).filter(l => l);
}

// ============================================================
// 🎯 FUNÇÃO CENTRAL — ÚNICO PONTO PARA REGISTRAR RESULTADOS
//
// Só a interface de ÁREA deve chamar esta função. Ela:
//  1. marca a luta como finalizada
//  2. atualiza a pontuação (quando for rodízio)
//  3. avança o chaveamento automaticamente (quando for mata-mata)
//  4. define proximaLutaId nas lutas que alimentam a próxima
//  5. adiciona a nova luta gerada na MESMA área de origem
// ============================================================
function atualizarResultado(idLuta, vencedor, tipoVitoria) {
  let lutas = getLutas();
  let luta = lutas.find(l => l.id === idLuta);
  if (!luta || luta.status !== "pendente") return null; // idempotente

  luta.vencedor = vencedor;
  luta.tipoVitoria = tipoVitoria;
  luta.status = "finalizada";
  saveLutas(lutas);

  let categorias = getCategorias();
  let categoria = categorias.find(c => c.id === luta.categoriaId);
  if (!categoria) return luta;

  // ---------- RODÍZIO: só pontuação, sem avanço de fase ----------
  if (luta.tipo === "rodizio") {
    let pontos = pontosPorTipo(tipoVitoria);
    categoria.tabela[vencedor].pontos += pontos;
    categoria.tabela[vencedor].vitorias += 1;
    saveCategorias(categorias);
  }

  // ---------- MELHOR DE 3: verifica se a série já foi decidida ----------
  else if (luta.tipo === "melhorDe3") {
    let lutasDaSerie = getLutas().filter(
      l => l.categoriaId === categoria.id && l.tipo === "melhorDe3"
    );

    let vitoriasPorAtleta = {};
    lutasDaSerie.forEach(l => {
      if (l.status === "finalizada" && l.vencedor) {
        vitoriasPorAtleta[l.vencedor] = (vitoriasPorAtleta[l.vencedor] || 0) + 1;
      }
    });

    let campeaoSerie = Object.keys(vitoriasPorAtleta).find(a => vitoriasPorAtleta[a] >= 2);

    if (campeaoSerie) {
      let vice = categoria.atletas.find(a => a !== campeaoSerie);
      categoria.finalizada = true;
      categoria.resultadoFinal = { campeao: campeaoSerie, vice: vice, terceiro: null };
      saveCategorias(categorias);

      // A série já foi decidida (2 vitórias) — cancela a luta restante, se houver
      let lutasAtualizadas = getLutas();
      lutasAtualizadas.forEach(l => {
        if (l.categoriaId === categoria.id && l.tipo === "melhorDe3" && l.status === "pendente") {
          l.status = "cancelada";
        }
      });
      saveLutas(lutasAtualizadas);
    }
  }

  // ---------- MATA-MATA: avanço automático de fase ----------
  else if (luta.tipo === "mataMata") {
    let lutasDaFase = getLutas()
      .filter(l => l.categoriaId === categoria.id && l.tipo === "mataMata" && l.fase === luta.fase)
      .sort((a, b) => a.posicao - b.posicao);

    let todasFinalizadas = lutasDaFase.every(l => l.status === "finalizada");

    if (todasFinalizadas) {
      if (lutasDaFase.length === 1) {
        // 🏆 Final decidida
        let final = lutasDaFase[0];
        let campeao = final.vencedor;
        let vice = (final.atletaA === campeao) ? final.atletaB : final.atletaA;

        let lutasFaseAnterior = getLutas()
          .filter(l => l.categoriaId === categoria.id && l.tipo === "mataMata" && l.fase === luta.fase - 1)
          .sort((a, b) => a.posicao - b.posicao);

        // Heurística simples de 3º lugar: perdedor da primeira semifinal
        // (não é uma disputa de 3º lugar real — pode ser refinado depois)
        let terceiros = [];

lutasFaseAnterior.forEach(semi => {
  let perdedor = (semi.vencedor === semi.atletaA) ? semi.atletaB : semi.atletaA;
  terceiros.push(perdedor);
});

let terceiro = terceiros.join(" / ");

        categoria.finalizada = true;
        categoria.resultadoFinal = { campeao, vice, terceiro };
        saveCategorias(categorias);
      } else {
        // Evita gerar a próxima fase duas vezes
        let jaAvancou = getLutas().some(
          l => l.categoriaId === categoria.id && l.tipo === "mataMata" && l.fase === luta.fase + 1
        );

        if (!jaAvancou) {
          let lutasArr = getLutas();

          for (let i = 0; i < lutasDaFase.length; i += 2) {
            let lutaA = lutasDaFase[i];
            let lutaB = lutasDaFase[i + 1];

            let atletaA = lutaA.vencedor;
            let atletaB = lutaB ? lutaB.vencedor : "BYE";

            // Regra simples por enquanto: a nova luta fica na MESMA área
            // da primeira luta que a originou
            let areaOrigem = getAreaDaLuta(lutaA.id);

            let novaLuta = {
              id: proximoId(lutasArr),
              categoriaId: categoria.id,
              atletaA: atletaA,
              atletaB: atletaB,
              vencedor: null,
              tipoVitoria: null,
              status: "pendente",
              tipo: "mataMata",
              fase: luta.fase + 1,
              posicao: i / 2,
              proximaLutaId: null
            };
            lutasArr.push(novaLuta);

            let refA = lutasArr.find(l => l.id === lutaA.id);
            if (refA) refA.proximaLutaId = novaLuta.id;

            if (lutaB) {
              let refB = lutasArr.find(l => l.id === lutaB.id);
              if (refB) refB.proximaLutaId = novaLuta.id;
            }

            if (areaOrigem) {
              adicionarLutaNaArea(areaOrigem.id, novaLuta.id);
            }
          }

          saveLutas(lutasArr);
        }
      }
    }
  }

  return getLutaPorId(idLuta);
}
