#!/usr/bin/env python3
"""
Draft Spanish translations for every i18n.py key that's missing/stale, write
them into i18n.py with reviewed=False, and generate an AuditLab review-request
file + a firmchat-ready one-liner.

2026-08-19 (Devin's direct go-ahead, RC session): this is the "AuditLab loop"
half of the Phase A rollout -- see i18n.py's own module docstring and
Orchestrator/outbox/assetlab.md's 2026-08-19T13:20 plan entry for the full
design. This script does the DRAFTING (Claude-authored, no paid MT API, no
new cost) -- it deliberately never sets reviewed=True itself. Only AuditLab's
own review (or a human) can flip that, via a follow-up edit to i18n.py's ES
dict once the review verdict comes back. Running this script twice on an
unreviewed draft is a no-op for that key (it's already the newest draft);
it only re-drafts a key whose EN string changed since the last draft (the
same staleness check the build gate uses).

Usage: python3 scripts/es_translation_review.py
"""

from __future__ import annotations

import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import i18n  # noqa: E402

I18N_PATH = REPO_ROOT / "i18n.py"
AUDITLAB_INBOX = pathlib.Path(r"C:\Users\Devin\AuditLab\inbox")

# ---------------------------------------------------------------------------
# Drafts: Claude-translated Spanish for every EN key as of 2026-08-19. Real,
# considered translations (not placeholder/machine-gibberish) -- neutral
# Latin American Spanish register appropriate for a professional/legal
# context, matching the site's own precise, sourcing-focused voice. Every
# entry here is reviewed=False until AuditLab (or a human) confirms it.
# ---------------------------------------------------------------------------
DRAFTS: dict[str, str] = {
    "site.tagline": "Fechas límite de renovación de licencias de CPA por estado — verificadas y actualizadas",
    "nav.browse_states": "Explorar estados",
    "nav.how_we_verify": "Cómo verificamos",
    "nav.guides": "Guías",
    "nav.for_firms": "Para firmas",
    "nav.live_demo": "Demo en vivo",
    "nav.sign_in": "Iniciar sesión",
    "nav.get_reminders": "Recibir recordatorios",
    "nav.dashboard": "Panel de control",
    "footer.heading_data_method": "Datos y método",
    "footer.link_mobility_rule_changes": "Cambios en normas de movilidad",
    "footer.link_practice_privilege_check": "Verificación de privilegio de práctica",
    "footer.link_multi_state_firms": "Firmas multiestatales",
    "footer.heading_product": "Producto",
    "footer.link_all_jurisdictions": "Las {count} jurisdicciones",
    "footer.link_pricing": "Precios",
    "footer.link_deadline_calculator": "Calculadora de fechas límite",
    "footer.link_cpe_vs_license": "CPE vs. renovación de licencia",
    "footer.link_roadmap": "Hoja de ruta",
    "footer.heading_company": "Empresa",
    "footer.link_contact": "Contacto",
    "footer.link_security": "Seguridad",
    "footer.link_status": "Estado del servicio",
    "footer.link_terms": "Términos",
    "footer.link_privacy": "Privacidad",
    "footer.trust_chip": "Sin rastreadores de anuncios ni redes sociales. Solo análisis sin cookies.",
    "footer.disclaimer_bold": "{site_name} es un servicio independiente de recordatorios operado por {brand_name}.",
    "footer.disclaimer_rest": (
        "No está afiliado, respaldado ni conectado con NASBA, el AICPA, ni ninguna junta estatal de "
        "contabilidad. Las fechas de renovación se recopilan de fuentes públicas únicamente con fines "
        "informativos — no constituyen asesoría legal, fiscal ni profesional. Confirme siempre su "
        "fecha exacta de renovación con la junta de su estado o en su licencia."
    ),
    "methodology.title": "Cómo verificamos cada fecha límite",
    "methodology.freshness_stat": (
        "registros con fecha en los conjuntos de datos de este sitio (fechas límite de renovación, "
        "horas de CPE, reincorporación, tarifas de renovación) fueron verificados individualmente "
        "contra su fuente en los últimos {threshold_days} días, a la fecha de la última compilación "
        "de esta página ({build_date}). La línea “Última verificación” de cada página "
        "estatal muestra la fecha propia de esa cita específica — es el mismo dato, agregado "
        "para todo el sitio."
    ),
    "methodology.intro": (
        "Los CPA están capacitados para ser escépticos ante fuentes no verificadas — así que esto "
        "es exactamente cómo se obtienen, verifican y mantienen actualizadas las fechas de este "
        "sitio. Nada de lo siguiente es aspiracional; describe el estándar real ya aplicado a cada "
        "página estatal."
    ),
    "methodology.h2_two_source_rule": "La regla de las dos fuentes",
    "methodology.two_source_intro": "Toda fecha en este sitio debe remitirse a dos elementos independientes antes de publicarse:",
    "methodology.two_source_item1": (
        "<strong>La propia página de la junta estatal</strong> — la fuente en lenguaje sencillo "
        "que la mayoría de las personas encontraría primero."
    ),
    "methodology.two_source_item2": (
        "<strong>El estatuto codificado o la norma administrativa real</strong> de la que se deriva "
        "el requisito de la junta — no un resumen, sino el texto legal primario mismo. Esa cita y un "
        "enlace directo a ella se muestran debajo de cada fecha verificada en este sitio, con la "
        "etiqueta “Fuente oficial”."
    ),
    "methodology.two_source_fallback": (
        "Si no podemos encontrar o confirmar la segunda fuente, la fecha no se publica como un hecho "
        "confirmado. En su lugar, la página lo indica claramente y le remite a la junta estatal "
        "oficial para que determine su fecha límite exacta — no adivinamos, interpolamos ni "
        "inferimos una fecha que no podamos respaldar con la ley primaria."
    ),
    "methodology.h2_verified_badge": "Qué significa la insignia “Verificado”",
    "methodology.verified_badge_body": (
        "Un recuadro destacado muestra una insignia <strong>Verificado</strong> solo cuando esa "
        "fecha específica tiene una cita real a la ley codificada que la respalda, verificada de la "
        "manera descrita arriba. Un registro sin ella nunca muestra la insignia — no existe un "
        "estado intermedio donde una fecha parezca confirmada sin estarlo."
    ),
    "methodology.h2_last_verified": "Qué significa “Última verificación”",
    "methodology.last_verified_intro": (
        "La fecha que se muestra en la línea de confianza de cada estado es la última vez que "
        "verificamos directamente la cita de ese estado contra el texto de la fuente primaria — "
        "no solo releímos nuestras propias notas al respecto. Periódicamente volvemos a ejecutar "
        "una verificación automatizada en cada fuente citada, buscando dos cosas:"
    ),
    "methodology.last_verified_item1": "un enlace roto o redirigido, o",
    "methodology.last_verified_item2": "cualquier indicio de que la norma subyacente haya sido modificada desde entonces.",
    "methodology.last_verified_followup": (
        "Cuando aparece cualquiera de los dos, verificamos manualmente antes de cambiar algo que un "
        "visitante vea — una alerta automatizada nunca reescribe silenciosamente una fecha "
        "publicada por sí sola."
    ),
    "methodology.h2_fall_short": "Dónde esto todavía puede quedar corto, con honestidad",
    "methodology.fall_short_body": (
        "Algunas fuentes son genuinamente más difíciles de verificar por medios automatizados — un "
        "puñado de citas remiten a documentos PDF o páginas renderizadas con JavaScript que nuestras "
        "herramientas no pueden extraer automáticamente. Cuando ese es el caso, esas citas fueron "
        "confirmadas individualmente a mano en el momento en que se publicaron; revelamos la "
        "limitación de la herramienta en lugar de fingir que una verificación más sencilla la cubre. "
        "Si una norma cambia entre nuestras verificaciones, use el enlace de contacto abajo para "
        "señalarlo y la volveremos a verificar y corregir rápidamente."
    ),
    "methodology.h2_what_we_dont_verify": "Qué no verificamos de esta manera",
    "methodology.dont_verify_body": (
        "La finalización de horas de CPE es autoinformada dondequiera que este sitio o su nivel "
        "para firmas la mencione — lo etiquetamos claramente y nunca le damos el mismo tratamiento "
        "de “Verificado” que a una fecha de renovación con fuente. Tampoco verificamos de forma "
        "independiente los futuros cambios de política de un estado; si un estado propone una nueva "
        "norma que aún no ha entrado en vigor, esperamos a que se convierta en la norma vigente real "
        "antes de citarla."
    ),
    "methodology.h2_see_for_yourself": "Compruébelo usted mismo",
    "methodology.see_for_yourself_body": (
        "Elija cualquier página estatal y busque la línea “Fuente oficial” debajo de su fecha "
        "— la cita y el enlace “leer la norma” llevan al texto legal primario, no a un resumen. "
        "Ese es el mismo estándar detrás de cada fecha en este sitio."
    ),
    "methodology.backlink_changelog": "Vea exactamente qué cambió y cuándo →",
    "methodology.backlink_contact": "¿Encontró algo que parece incorrecto? Avísenos →",
    "methodology.meta_description": (
        "El estándar de verificación de Deadline-Radar: cada fecha de renovación de licencia de CPA "
        "remite a la propia página de la junta estatal más el estatuto o norma codificada real "
        "detrás de ella — nunca una suposición."
    ),
    "contact.h1": "Contacto",
    "contact.intro": "Preguntas, una corrección a una fecha límite, o cualquier otra cosa — nos gustaría saber de usted.",
    "contact.h2_email_us": "Escríbanos",
    "contact.email_body": (
        "Leemos cada mensaje y normalmente respondemos en un par de días hábiles. Este es un "
        "proyecto pequeño e independiente — hay una persona real del otro lado, no una cola de "
        "soporte. Nuestra dirección también se publica de forma legible por máquina en "
        "{security_txt_link} según {rfc_link}."
    ),
    "contact.privacy_policy_link_text": "Política de Privacidad",
    "contact.h2_live_chat": "Chat en vivo",
    "contact.live_chat_body": (
        "¿Prefiere hablarlo ahora mismo? Iniciar un chat carga un widget de chat en vivo (Tawk.to) "
        "— no se ejecuta en esta página hasta que hace clic en el botón de abajo, por lo que "
        "nunca establece su propia cookie a menos que realmente lo use. Consulte nuestra "
        "{privacy_link} para saber qué comparte ese widget y qué no."
    ),
    "contact.live_chat_button": "Iniciar un chat en vivo",
    "contact.h2_wrong_date": "¿Encontró una fecha incorrecta?",
    "contact.wrong_date_body": (
        "Las fechas límite se recopilan de fuentes oficiales de las juntas estatales y trabajamos "
        "arduamente para mantenerlas actualizadas, pero las normas cambian. Si una fecha parece "
        "incorrecta, envíenos por correo el estado y lo que está viendo, y la verificaremos "
        "contra la fuente y la corregiremos rápidamente. Siempre confirme su fecha límite exacta "
        "con la junta de su estado antes de confiar en ella."
    ),
    "contact.h2_stop_reminders": "Detenga sus recordatorios",
    "contact.stop_reminders_body": (
        "La forma más rápida de detener los recordatorios es el enlace de baja de un clic al "
        "final de cualquier correo que enviemos — es instantáneo y permanente. También puede "
        "escribirnos por correo."
    ),
    "contact.h2_mailing_address": "Dirección postal",
    "contact.meta_description": (
        "Contacte a Deadline-Radar — preguntas, correcciones de fechas límite, o ayuda con sus "
        "recordatorios de renovación de licencia de CPA. Escríbanos por correo o inicie un chat en vivo."
    ),
    "contact.chat_loading": "Cargando chat…",
    "contact.chat_loading_hint": "Esto puede tardar unos segundos en una conexión lenta.",
    "contact.chat_ready": "Chat cargado — busque la burbuja en la esquina",
    "contact.chat_slow": "Todavía conectando — si esto no termina en unos segundos más, escríbanos en su lugar: {email}",
    "msf.h1": "¿Dirige una firma de CPA multiestatal? Aquí está el panorama completo.",
    "msf.intro": (
        "Una firma con personal licenciado o ejerciendo en más de un estado tiene un problema "
        "genuinamente distinto al de una firma de un solo estado: saber dónde puede trabajar "
        "legalmente cada persona, detectarlo antes de que una norma cambie bajo sus pies, y "
        "mantener una cita detrás de cada respuesta. Tres piezas de este sitio trabajan juntas "
        "exactamente para eso."
    ),
    "msf.h2_map": "1. Mapa — vea en qué estados puede ejercer todo su equipo",
    "msf.map_body": (
        "Un mapa codificado por colores que muestra exactamente en qué estados su equipo puede "
        "ejercer hoy sin una licencia local, más una verificación de registro a nivel de firma "
        "para trabajo de certificación donde su propia firma (no solo el CPA individual) necesita "
        "registrarse. Parte de un plan de firma de pago — {pricing_link}."
    ),
    "msf.see_plans": "ver planes",
    "msf.h2_ppc": "2. Verificación de privilegio de práctica — confirme antes de que el personal asuma trabajo fuera del estado",
    "msf.ppc_body": (
        "Antes de que un CPA de su equipo asuma trabajo en un estado donde no tiene licencia "
        "local, ejecute la verificación: tipo de servicio, estado de origen, estado de destino, y "
        "la respuesta llega con la norma y la cita que la respaldan — nunca una suposición. "
        "{ppc_link}."
    ),
    "msf.ppc_link_text": "Gratis para cualquier cuenta, sin plan de pago requerido",
    "msf.h2_rule_changes": "3. Cambios de normas — un feed continuo, no una verificación única",
    "msf.rule_changes_body": (
        "Un feed continuo de cambios confirmados y pendientes a las normas de movilidad "
        "interestatal de CPA — privilegios de práctica, requisitos de aviso/tarifa, y registro de "
        "firmas — obtenido de la misma manera que cada fecha en este sitio: una cita al estatuto o "
        "norma primaria donde pudimos confirmarla, y claramente etiquetado donde solo pudimos "
        "confirmarla contra la propia página de la junta, nunca una suposición. El calendario de "
        "su propia firma muestra los cambios que realmente afectan a los estados de su equipo. "
        "{feed_link}."
    ),
    "msf.feed_link_text": "Vea el feed público completo",
    "msf.try_demo": "Pruebe la demo en vivo →",
    "msf.new_here_bold": "¿Nuevo en Deadline-Radar?",
    "msf.new_here_rest": (
        "Vea el {overview_link} para precios, el conjunto completo de funciones, y cómo el "
        "seguimiento de fechas de renovación encaja junto con estas tres."
    ),
    "msf.overview_link_text": "resumen completo para firmas",
    "msf.backlink_all_states": "← Volver a todos los estados",
    "msf.title": "Firmas de CPA multiestatales: mapa, verificación de movilidad y cambios de normas",
    "msf.meta_description": (
        "Para una firma de CPA con personal en varios estados: un mapa de cobertura, una "
        "Verificación de privilegio de práctica gratuita, y un feed continuo de cambios de normas "
        "de movilidad — todo con fuentes y citas."
    ),
    "ppc.h1": "Verificación de privilegio de práctica: ¿puede un CPA trabajar en otro estado sin licencia?",
    "ppc.subhead": (
        "¿Puede este CPA prestar este servicio en este estado — y qué tiene que suceder "
        "primero? Cada respuesta está vinculada a la norma de la que proviene."
    ),
    "ppc.callout_bold": "Informativo, no asesoría legal.",
    "ppc.callout_rest": (
        "Las normas de privilegio de práctica cambian, y dependen de hechos que no podemos ver. Le "
        "mostramos la norma y de dónde proviene para que pueda verificarla usted mismo — y "
        "donde no hemos verificado algo contra una fuente primaria, lo decimos en lugar de "
        "adivinar. Confirme con la junta estatal antes de confiar en cualquier respuesta aquí."
    ),
    "ppc.h2_what_it_does": "Qué hace realmente Verificación de privilegio de práctica",
    "ppc.what_it_does_intro": (
        "Una pregunta distinta a las fechas de renovación: ¿puede este CPA prestar este servicio "
        "específico en este estado específico ahora mismo, sin una licencia local — y qué tiene "
        "que suceder primero?"
    ),
    "ppc.item_pick_service_bold": "Elija un tipo de servicio:",
    "ppc.item_pick_service_rest": "Impuestos; Certificación (auditoría, revisión, u otra certificación); u Otro no certificado (consultoría, asesoría).",
    "ppc.item_attest_gap_bold": "Cuidado con el vacío de certificación:",
    "ppc.item_attest_gap_rest": (
        "el trabajo de certificación frecuentemente activa un requisito de registro de firma "
        "donde el trabajo de impuestos no lo hace — ese es el error de movilidad más común en "
        "la práctica real, y esto lo detecta."
    ),
    "ppc.item_confirm_bold": "Lo que necesitará confirmar:",
    "ppc.item_confirm_rest": (
        "que la licencia esté activa y en regla, y que el CPA cumpla con la equivalencia "
        "sustancial (150 horas semestrales, un año de experiencia, el Examen Uniforme de CPA). No "
        "podemos verificar ninguno de los dos datos nosotros mismos — la respuesta es tan buena "
        "como lo que usted indique, el mismo estándar de honestidad que cada fecha de renovación "
        "en este sitio."
    ),
    "ppc.coverage_body": (
        "Verificado en las 55 jurisdicciones de EE. UU. hoy, tanto para la pregunta individual "
        "de arriba como para una <strong>verificación de registro a nivel de firma</strong> "
        "separada — si la FIRMA misma necesita registrarse en algún lugar donde no tiene "
        "oficina, incluso cuando el CPA individual está cubierto."
    ),
    "ppc.free_tier_body": (
        "La verificación individual es gratuita en todos los niveles, para cualquier cuenta — "
        "un registro gratuito es todo lo que se necesita, sin tarjeta, sin plan de pago "
        "requerido. {pricing_link}."
    ),
    "ppc.free_tier_link_text": "La verificación a nivel de firma y el mapa de cobertura multiestatal son parte de un plan de pago",
    "ppc.run_check": "Ejecute una verificación gratuita ahora →",
    "ppc.tracking_bold": "¿Está siguiendo el personal de toda una firma, no solo una consulta?",
    "ppc.tracking_rest": (
        "Vea el {overview_link} — Roster, Calendario, seguimiento de CPE, y la Verificación de "
        "privilegio de práctica individual también son gratis allí; los niveles de pago agregan "
        "el mapa multiestatal y la verificación de registro a nivel de firma. Vea {pricing_link2}."
    ),
    "ppc.overview_link_text": "resumen para firmas",
    "ppc.full_pricing_link_text": "los precios completos",
    "ppc.backlink_all_states": "← Volver a todos los estados",
    "ppc.title": "Verificación de privilegio de práctica",
    "ppc.meta_description": (
        "Qué significa el privilegio de práctica (movilidad) de CPA, cómo funciona la "
        "equivalencia sustancial, y cómo verificar si un CPA puede atender a un cliente en otro "
        "estado sin una licencia local — gratis, verificado en las 55 jurisdicciones de EE. UU."
    ),
}


def _format_es_dict(es: dict[str, dict]) -> str:
    lines = ["ES: dict[str, dict] = {"]
    for key in sorted(es):
        entry = es[key]
        lines.append(f"    {key!r}: {{")
        lines.append(f"        \"text\": {entry['text']!r},")
        lines.append(f"        \"en_hash\": {entry['en_hash']!r},")
        lines.append(f"        \"reviewed\": {entry['reviewed']!r},")
        lines.append("    },")
    lines.append("}")
    return "\n".join(lines)


def main() -> None:
    stale = set(i18n.stale_or_missing_keys())
    missing_drafts = stale - DRAFTS.keys()
    if missing_drafts:
        print(f"WARNING: {len(missing_drafts)} key(s) need translation but have no draft here: {sorted(missing_drafts)}")

    new_es = dict(i18n.ES)  # keep any already-reviewed entries untouched
    drafted_this_run = []
    for key, text in DRAFTS.items():
        if key not in i18n.EN:
            print(f"WARNING: draft for unknown key {key!r} -- skipping (stale script?)")
            continue
        if key in stale:
            new_es[key] = {"text": text, "en_hash": i18n.en_hash(key), "reviewed": False}
            drafted_this_run.append(key)

    if not drafted_this_run:
        print("Nothing to draft -- every key is already translated, reviewed, and not stale.")
        return

    # Rewrite i18n.py's ES dict block in place.
    src = I18N_PATH.read_text(encoding="utf-8")
    new_block = _format_es_dict(new_es)
    pattern = re.compile(r"^ES: dict\[str, dict\] = \{.*?\n\}|^ES: dict\[str, dict\] = \{\}", re.DOTALL | re.MULTILINE)
    if not pattern.search(src):
        raise SystemExit("Could not find 'ES: dict[str, dict] = {...}' block in i18n.py -- aborting, not writing.")
    new_src = pattern.sub(new_block, src, count=1)
    I18N_PATH.write_text(new_src, encoding="utf-8")
    print(f"Drafted {len(drafted_this_run)} translation(s) into i18n.py, all reviewed=False: {sorted(drafted_this_run)}")

    # Review-request file for AuditLab.
    review_lines = [
        "---",
        "from: assetlab",
        "to: auditlab",
        f"date: {__import__('datetime').date.today().isoformat()}",
        "type: review-request",
        "---",
        "",
        "# Spanish translation review batch -- /es/methodology/ (Phase A proof-of-concept)",
        "",
        "Real review request (not the earlier heads-up) -- these are live drafts, please review.",
        "",
        "For each entry: does the Spanish text mean the same thing as the English source, with no",
        "softened/changed claim? Numbers, dates, and any `{placeholder}` tokens must appear",
        "unchanged (they're filled in with real data at build time, not translated). Report back",
        "to `AssetLab/inbox/` per your own charter's \"report to both\" rule -- APPROVE or FLAG each",
        "key, not just a batch verdict, so an approved subset can ship even if others need a redraft.",
        "",
    ]
    for key in sorted(drafted_this_run):
        review_lines.append(f"## `{key}`")
        review_lines.append(f"**EN**: {i18n.EN[key]!r}")
        review_lines.append(f"**ES (draft)**: {DRAFTS[key]!r}")
        review_lines.append("")

    if AUDITLAB_INBOX.is_dir():
        out_path = AUDITLAB_INBOX / f"assetlab_{__import__('datetime').date.today().strftime('%Y%m%d')}_es_review_batch1.md"
        out_path.write_text("\n".join(review_lines), encoding="utf-8")
        print(f"Wrote review request: {out_path}")
    else:
        print(f"AuditLab inbox not found at {AUDITLAB_INBOX} -- review request NOT written, print only.")


if __name__ == "__main__":
    main()
