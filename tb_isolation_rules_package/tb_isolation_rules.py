"""Deterministic COMMUNITY TB restriction proposal, version 0.2.0.

Research/pilot implementation requiring clinical policy validation before deployment.
No external dependencies. Python >=3.10. See RULES_AND_EVIDENCE.txt.
Run: python tb_isolation_rules.py example_input.json
Inputs describe the assessment NOW; never use later DST to rewrite an earlier decision.
"""
from __future__ import annotations
from dataclasses import dataclass, fields, asdict
import argparse
import json
from pathlib import Path

VERSION = "0.2.0-user-policy"
GRADES = ("low", "moderate", "high", "unknown")
TRI = ("yes", "no", "unknown")
RANK = {"low": 0, "moderate": 1, "high": 2}


@dataclass(frozen=True)
class Inputs:
    # Optional context only: missing setting never changes the restriction level.
    setting: str = "unknown"  # community, healthcare, congregate_facility, unknown
    respiratory_tb: str = "unknown"  # yes, no (evaluated and excluded), unknown
    age_years: int | None = None
    pediatric_noninfectious_confirmed: str = "unknown"
    adult_type_disease: str = "unknown"
    # PRETREATMENT observations only. MTB detection and RIF resistance are separate.
    pretreatment_burden: str = "unknown"
    smear: str = "unknown"  # negative, scanty, 1+, 2+, 3+, 4+, unknown
    cough: str = "unknown"  # none, mild, frequent, unknown
    cavitation: str = "unknown"
    extensive_radiographic_disease: str = "unknown"
    gxp_mtb: str = "unknown"  # detected, not_detected, unknown
    gxp_load: str = "unknown"  # trace, very_low, low, medium, high, unknown
    rifampin: str = "unknown"  # susceptible, resistant, indeterminate, unknown
    other_resistance: str = "unknown"  # none_detected, inh, pza, other, unknown
    resistance_suspected: str = "unknown"  # clinical/epidemiologic concern
    resistance_addressed_by_regimen: str = "unknown"
    # Explicit adverse findings override the disclosed planning defaults.
    on_treatment: str = "unknown"
    regimen_appropriate: str = "unknown"  # adequate multidrug regimen/doses
    effectiveness_assessed: str = "unknown"  # clinician judgment, yes/no/unknown
    adherence_verified: str = "unknown"
    tolerance_adequate: str = "unknown"  # includes absorption/interactions if relevant
    lab_supports_regimen: str = "unknown"  # DST supports actual regimen, not GXP alone
    uninterrupted_effective_days: int | None = None
    days_since_isolation_started: int | None = None
    clinical_response: str = "unknown"  # improving, stable, worsening, asymptomatic, unknown
    micro_response: str = "unknown"  # improving, stable, worsening, unknown
    adverse_response_explained: str = "unknown"  # reviewed alternative cause/sampling issue
    # Community risk is FUTURE exposure if restrictions are lifted, not past exposure.
    community_risk: str = "unknown"
    exposure_duration: str = "unknown"  # brief, recurrent, prolonged, unknown
    exposure_proximity: str = "unknown"  # distant, shared_air, close, unknown
    exposure_environment: str = "unknown"  # outdoor, well_ventilated, poor_ventilation, unknown
    new_contacts: str = "unknown"  # none, few, many, unknown
    vulnerable_contacts: str = "unknown"  # under 5 or immunosuppressed, exposed prospectively
    congregate_return: str = "unknown"
    targeted_restrictions_feasible: str = "unknown"
    # Subjective harm grades after available supports; never infer low from silence.
    patient_harm: str = "unknown"
    financial_harm: str = "unknown"
    housing_harm: str = "unknown"
    food_harm: str = "unknown"
    stigma_harm: str = "unknown"
    mental_health_harm: str = "unknown"
    access_to_care_harm: str = "unknown"
    # Accountable, named individual extensions, not fixed durations for diagnoses.
    individualized_minimum_days: int | None = None
    individualized_reason: str = ""
    expert_review_completed: str = "unknown"
    gene_xpert: str = "unknown"
    treatment_days: int | None = None
    patient_immunosuppressed: str = "unknown"
    symptoms_resolved: str = "unknown"
    employment_harm: str = "unknown"
    jurisdiction: str = "unspecified"
    local_policy_minimum_days: int | None = None
    local_policy_reason: str = ""


ENUMS = {name: TRI for name in (
    "respiratory_tb", "pediatric_noninfectious_confirmed", "adult_type_disease",
    "cavitation", "extensive_radiographic_disease", "resistance_suspected",
    "resistance_addressed_by_regimen", "on_treatment", "regimen_appropriate",
    "effectiveness_assessed", "adherence_verified", "tolerance_adequate",
    "lab_supports_regimen", "adverse_response_explained", "vulnerable_contacts",
    "congregate_return", "targeted_restrictions_feasible", "expert_review_completed",
    "patient_immunosuppressed", "symptoms_resolved")}
ENUMS.update({name: GRADES for name in (
    "pretreatment_burden", "community_risk", "patient_harm", "financial_harm",
    "housing_harm", "food_harm", "stigma_harm", "mental_health_harm", "access_to_care_harm", "employment_harm")})
ENUMS.update({
    "setting": ("community", "healthcare", "congregate_facility", "unknown"),
    "smear": ("negative", "positive", "scanty", "1+", "2+", "3+", "4+", "unknown"),
    "cough": ("none", "mild", "frequent", "unknown"),
    "gxp_mtb": ("detected", "not_detected", "unknown"),
    "gxp_load": ("trace", "very_low", "low", "medium", "high", "unknown"),
    "rifampin": ("susceptible", "resistant", "indeterminate", "unknown"),
    "other_resistance": ("none_detected", "inh", "pza", "other", "unknown"),
    "clinical_response": ("improving", "stable", "worsening", "asymptomatic", "unknown"),
    "micro_response": ("improving", "stable", "worsening", "unknown"),
    "exposure_duration": ("brief", "recurrent", "prolonged", "unknown"),
    "exposure_proximity": ("distant", "shared_air", "close", "unknown"),
    "exposure_environment": ("outdoor", "well_ventilated", "poor_ventilation", "unknown"),
    "new_contacts": ("none", "few", "many", "unknown"),
    "gene_xpert": ("rif_sensitive", "rif_resistant", "unavailable", "not_detected", "unknown"),
    "jurisdiction": ("unspecified", "washington", "other"),
})
INTEGER_FIELDS = ("age_years", "uninterrupted_effective_days", "days_since_isolation_started",
                  "individualized_minimum_days", "treatment_days", "local_policy_minimum_days")

ALIASES = {"bacterial_burden": "pretreatment_burden", "gxp_status": "gene_xpert",
           "drug_resistance_concern": "resistance_suspected", "days_of_treatment": "treatment_days",
           "treatment_effective": "effectiveness_assessed", "adherent": "adherence_verified",
           "tolerating": "tolerance_adequate", "cavity": "cavitation", "sputum_smear": "smear",
           "immunosuppressed": "patient_immunosuppressed", "congregate_or_shelter": "congregate_return"}


def parse_inputs(data: dict) -> Inputs:
    if not isinstance(data, dict):
        raise ValueError("Input must be a JSON object")
    data = dict(data)
    for alias, canonical in ALIASES.items():
        if alias in data:
            if canonical in data and data[canonical] != data[alias]:
                raise ValueError(f"Conflicting {alias} and {canonical}")
            data[canonical] = data.pop(alias)
    extra = set(data) - {f.name for f in fields(Inputs)}
    if extra:
        raise ValueError(f"Unrecognized input field(s): {sorted(extra)}")
    normalized = dict(data)
    for name in ENUMS:
        if name in normalized:
            v = normalized[name]
            if v is None or v == "":
                v = "unknown"
            if type(v) is bool and ENUMS[name] == TRI:
                v = "yes" if v else "no"
            if not isinstance(v, str):
                raise ValueError(f"{name} must be a named string value")
            v = v.strip().lower()
            if name == "gene_xpert":
                v = {"detected rif sensitive": "rif_sensitive", "detected rifampin sensitive": "rif_sensitive",
                     "rif-s": "rif_sensitive", "rifampin-susceptible": "rif_sensitive",
                     "detected rif resistant": "rif_resistant", "detected rifampin resistant": "rif_resistant",
                     "rif-r": "rif_resistant", "not available": "unavailable"}.get(v, v)
            if name == "jurisdiction":
                v = {"wa": "washington", "washington state": "washington", "unknown": "unspecified"}.get(v,v)
            if name == "micro_response":
                v = {"declining": "improving", "unchanged": "stable", "rising": "worsening"}.get(v,v)
            if name == "clinical_response":
                v = {"no improvement": "stable", "not improving": "stable", "resolved": "asymptomatic"}.get(v,v)
            if name in (n for n, e in ENUMS.items() if e == GRADES) and v == "medium":
                v = "moderate"
            normalized[name] = v
    x = Inputs(**normalized)
    validate(x)
    return x


def validate(x: Inputs) -> None:
    for name, options in ENUMS.items():
        if getattr(x, name) not in options:
            raise ValueError(f"{name} must be one of {options}")
    for name in INTEGER_FIELDS:
        v = getattr(x, name)
        if v is not None and (type(v) is not int or v < 0):
            raise ValueError(f"{name} must be a nonnegative integer or null")
    if not isinstance(x.individualized_reason, str):
        raise ValueError("individualized_reason must be text")
    if x.individualized_minimum_days is not None and not x.individualized_reason.strip():
        raise ValueError("An individualized minimum requires a documented reason")
    if not isinstance(x.local_policy_reason, str):
        raise ValueError("local_policy_reason must be text")
    if x.local_policy_minimum_days is not None and not x.local_policy_reason.strip():
        raise ValueError("A local-policy minimum requires a documented policy reference/reason")
    if (x.treatment_days is not None and x.uninterrupted_effective_days is not None
            and x.uninterrupted_effective_days > x.treatment_days):
        raise ValueError("Effective-treatment days cannot exceed total treatment days")
    if x.gxp_mtb == "not_detected" and x.gxp_load != "unknown":
        raise ValueError("MTB not detected cannot have an MTB semiquantitative load")


def _max_grade(values: list[str]) -> str:
    known = [v for v in values if v != "unknown"]
    return max(known, key=RANK.get) if known else "unknown"


def evaluate(x: Inputs | dict) -> dict:
    """Apply the user's Oct 15 anchor policy. Missing decision-critical grades ask a
    question rather than fabricate extensive restrictions. See expected_days_of_restrictions
    (total effective-treatment target) and expected_remaining_days (conditional countdown).
    """
    if isinstance(x, dict):
        x = parse_inputs(x)
    validate(x)
    assumptions, questions, explanations, rules, blockers = [], [], [], [], []

    def assume(field, value, why):
        assumptions.append({"field": field, "value": value, "reason": why})
        return value

    def ask(field, text, required=False):
        if not any(q["field"] == field for q in questions):
            questions.append({"field": field, "question": text, "required_for_final_recommendation": required})

    # A supplied grade is enough; optional raw findings must not become mandatory gates.
    burden = x.pretreatment_burden
    high_marker = x.smear in ("2+", "3+", "4+") or x.cavitation == "yes"
    if burden == "unknown":
        if high_marker:
            burden = "high"
        elif x.smear in ("positive", "scanty", "1+") or x.cough == "frequent":
            burden = "moderate"
        elif ((x.smear == "negative" and x.cavitation != "yes") or
              (x.cavitation == "no" and x.cough == "none")):
            burden = "low"
        if burden != "unknown":
            explanations.append(f"Pretreatment burden inferred as {burden} from available smear/cough/cavity findings.")
            if "unknown" in (x.smear, x.cough, x.cavitation):
                assume("pretreatment_burden", burden, "Provisional inference from partial findings; unreported markers are not recorded as negative.")
                ask("pretreatment_burden", "Confirm the inferred burden or provide the missing pretreatment smear, cough, or cavity finding.")
        else:
            ask("pretreatment_burden", "Is initial bacterial burden low, medium, or high? Provide smear, cough, or cavity findings if available.", True)
    elif high_marker and burden != "high":
        ask("pretreatment_burden", "The supplied burden conflicts with a high smear grade or cavity. Confirm the burden grade.", True)
        blockers.append("CONFLICTING_BURDEN")
    # Grades are future shared-air risk, not an already treatment-adjusted risk score.
    community = x.community_risk
    if community == "unknown":
        if x.vulnerable_contacts == "yes" or x.congregate_return == "yes" or (
            x.exposure_duration in ("recurrent", "prolonged") and
            x.exposure_environment == "poor_ventilation"):
            community = "high"
        elif x.new_contacts == "none" or (
            x.new_contacts == "few" and x.exposure_duration == "brief" and
            x.exposure_environment in ("outdoor", "well_ventilated")):
            community = "low"
        elif x.new_contacts in ("few", "many") and x.exposure_duration != "unknown" and x.exposure_environment != "unknown":
            community = "moderate"
        if community == "unknown":
            ask("community_risk", "Is community risk low, medium, or high, considering new contacts, vulnerability, frequency, and ventilation?", True)
        else:
            explanations.append(f"Community risk inferred as {community} from prospective exposure details.")
    elif community != "high" and (x.vulnerable_contacts == "yes" or x.congregate_return == "yes"):
        community = "high"
        explanations.append("Prospective vulnerable-contact or congregate exposure raises community risk to high.")
    domains = [getattr(x, n) for n in ("financial_harm", "housing_harm", "food_harm", "employment_harm",
               "mental_health_harm", "stigma_harm", "access_to_care_harm")]
    harm = _max_grade([x.patient_harm] + domains)
    if harm == "unknown":
        harm = assume("patient_harm", "moderate", "No overall or domain harm grades supplied; user-specified default.")
        ask("patient_harm", "Would isolation cause low, medium, or high housing, financial, food, employment, or mental-health harm?")
    elif x.patient_harm == "unknown":
        explanations.append("Patient harm uses the highest reported domain grade; missing domains are not barriers.")

    rif = x.rifampin
    gx_rif = {"rif_sensitive": "susceptible", "rif_resistant": "resistant"}.get(x.gene_xpert)
    if gx_rif:
        if rif not in ("unknown", "indeterminate", gx_rif):
            blockers.append("CONFLICTING_RIF_RESULTS")
            ask("rifampin", "Resolve conflicting rifampin susceptibility results.", True)
        rif = "resistant" if "resistant" in (rif, gx_rif) else gx_rif
    elif x.gene_xpert in ("unavailable", "not_detected") and rif == "susceptible":
        explanations.append("Rifampin susceptibility was separately supplied; confirm the assay source. The no-GXP duration floor still applies.")
    # Explicit legacy RIF-S is treated as the available rapid susceptibility result.
    rapid_s = x.gene_xpert == "rif_sensitive" or (x.gene_xpert == "unknown" and rif == "susceptible" and x.gxp_mtb != "not_detected")
    concern = x.resistance_suspected
    if concern == "unknown":
        concern = assume("resistance_suspected", "no", "No clinical/epidemiologic concern reported; user-specified default, not proof of susceptibility.")
    known_resistance = rif == "resistant" or x.other_resistance in ("inh", "pza", "other")
    resistance = known_resistance or concern == "yes"
    if known_resistance:
        concern = "yes"
        explanations.append("Reported laboratory resistance overrides the default of no resistance concern.")
        assumptions[:] = [a for a in assumptions if a["field"] != "resistance_suspected"]

    adherent = x.adherence_verified
    tolerant = x.tolerance_adequate
    clinical = x.clinical_response
    for field, value in (("adherence_verified", adherent), ("tolerance_adequate", tolerant)):
        if value == "unknown":
            v = assume(field, "yes", "User-specified planning default; no contrary information supplied.")
            if field == "adherence_verified": adherent = v
            else: tolerant = v
            ask(field, "Confirm medication adherence." if field == "adherence_verified" else "Confirm treatment tolerance and ability to take the regimen.")
    if clinical == "unknown":
        clinical = assume("clinical_response", "improving", "User-specified planning default if receiving treatment; not an observed clinical finding.")
        ask("clinical_response", "Is the patient improving clinically, unchanged, worsening, or asymptomatic?")
    days = x.treatment_days if x.treatment_days is not None else x.uninterrupted_effective_days
    on_tx = x.on_treatment
    if on_tx == "unknown" and days is not None and days > 0:
        on_tx = "yes"
        explanations.append("Positive treatment-day count establishes that treatment has started.")
    elif on_tx == "unknown":
        on_tx = assume("on_treatment", "no", "Treatment start/duration unknown: zero effective-treatment credit.")
        ask("treatment_days", "Has treatment started, and how many completed days have been taken?")
    if x.on_treatment == "no" and days is not None and days > 0:
        blockers.append("CONFLICTING_TREATMENT_STATUS")
        ask("on_treatment", "Treatment is marked not started but positive treatment days were supplied. Resolve this conflict.", True)

    # Negative findings always override defaults and an asserted effectiveness flag.
    adverse = []
    if adherent == "no": adverse.append("ADHERENCE_CONCERN")
    if tolerant == "no": adverse.append("TOLERANCE_CONCERN")
    if clinical in ("stable", "worsening") and x.adverse_response_explained != "yes":
        adverse.append("NO_CLINICAL_IMPROVEMENT")
    if x.micro_response == "worsening" and x.adverse_response_explained != "yes":
        adverse.append("RISING_SMEAR")
    if x.regimen_appropriate == "no" or x.lab_supports_regimen == "no" or x.effectiveness_assessed == "no":
        adverse.append("TREATMENT_NOT_EFFECTIVE")
    effective, effectiveness_basis = False, "not_established"
    if on_tx == "yes" and not adverse:
        if x.effectiveness_assessed == "yes":
            effective, effectiveness_basis = True, "explicit_assessment"
        elif rapid_s and not resistance:
            effective, effectiveness_basis = True, "assumed_from_rif_susceptibility_and_no_concerns"
            assume("effectiveness_assessed", "yes", "RIF susceptible with no resistance concern and no reported adherence, tolerance, or response problem.")
        elif x.lab_supports_regimen == "yes" and x.regimen_appropriate == "yes" and (
            not resistance or x.resistance_addressed_by_regimen == "yes"):
            effective, effectiveness_basis = True, "regimen_supported_by_laboratory_and_clinician"
        else:
            ask("effectiveness_assessed", "Is the current regimen judged effective? Unknown/unavailable GXP alone cannot establish effectiveness.")
    credit = (x.uninterrupted_effective_days if x.uninterrupted_effective_days is not None else days) if effective else 0
    if credit is None:
        credit = 0
        ask("treatment_days", "How many completed days of effective treatment have been taken?")
    if effective and x.uninterrupted_effective_days is None and days is not None:
        assume("uninterrupted_effective_days", days, "Reported treatment days assumed continuously effective under the stated treatment assessment; correct if the regimen changed or doses were missed.")
    blockers += adverse
    if not effective:
        blockers.append("EFFECTIVE_TREATMENT_NOT_ESTABLISHED")
    if effective and days is None:
        blockers.append("TREATMENT_DURATION_UNKNOWN")

    pediatric = (x.age_years is not None and x.age_years < 10 and x.adult_type_disease == "no"
                 and (burden == "low" or x.pediatric_noninfectious_confirmed == "yes")
                 and x.smear not in ("positive", "scanty", "1+", "2+", "3+", "4+")
                 and x.cavitation != "yes")
    excluded = x.respiratory_tb == "no" and not high_marker and x.smear not in ("positive", "scanty", "1+")
    if x.respiratory_tb == "no" and not excluded:
        blockers.append("CONFLICTING_RESPIRATORY_EXCLUSION")
        ask("respiratory_tb", "Resolve respiratory-TB exclusion versus positive respiratory findings.", True)

    target = lo = hi = None
    special_symptoms = False
    if burden != "unknown" and community != "unknown":
        if not rapid_s:
            target = 10 if burden == "low" and community == "low" else 14
            rules.append("D_UNKNOWN_GXP_10_OR_14")
        elif community == "low":
            if burden == "low":
                target = 5
            elif burden == "moderate":
                target = 7
                if x.patient_immunosuppressed == "yes":
                    target, special_symptoms = 10, True
            else:
                target = 10 if harm == "low" else 5
            rules.append("D_RIF_S_LOW_COMMUNITY")
        elif community == "moderate":
            target = 7 if burden == "low" else (14 if burden == "high" and harm == "low" else 10)
            rules.append("D_INTERPOLATED_MEDIUM_COMMUNITY")
        else:
            target = 10 if burden == "low" or harm != "low" else 14
            rules.append("D_RIF_S_HIGH_COMMUNITY")
        lo = hi = target
        if rapid_s and burden == "high" and community == "low":
            lo, hi = (10, 14) if harm == "low" else (5, 10)
            rules.append("D_RANGE_LOWER_BOUND_WITH_FAVORABLE_RESPONSE")
            if adverse:
                target = hi
                rules.append("D_RANGE_UPPER_BOUND_RESPONSE_CONCERN")
        # Special flags do not impose the old blanket vulnerable-contact floor.
        if community == "high" and (x.congregate_return == "yes" or
             (burden == "low" and x.vulnerable_contacts == "yes" and harm == "low")):
            target = lo = hi = 14
            rules.append("D_SPECIAL_EXPOSURE_14")
        if resistance:
            target = lo = hi = max(target, 14)
            rules.append("D_RESISTANCE_EXPERT_PATHWAY")
        if special_symptoms and x.symptoms_resolved == "no" and clinical != "asymptomatic":
            target, lo, hi = 14, 10, 14
            explanations.append("Case 5c pattern: symptoms not resolved; use 14-day reassessment target while improving, without automatic extension beyond 14.")
        elif special_symptoms and x.symptoms_resolved == "unknown" and clinical != "asymptomatic":
            ask("symptoms_resolved", "Have symptoms resolved for the immunosuppressed moderate-burden case? The 10-day anchor is conditional on resolution.")
            if credit >= 10 and credit < 14:
                blockers.append("CASE_5C_SYMPTOM_RESOLUTION_UNCONFIRMED")
            if credit >= 14:
                target = lo = hi = 14
        if x.individualized_minimum_days is not None:
            target = max(target, x.individualized_minimum_days)
            lo, hi = target, max(hi, target)
            rules.append("D_DOCUMENTED_EXTENUATING_CIRCUMSTANCE")
        if x.local_policy_minimum_days is not None:
            target = max(target, x.local_policy_minimum_days)
            lo, hi = target, max(hi, target)
            rules.append("D_EXPLICIT_LOCAL_POLICY")
        # Positive but unchanged smear does not remove all earlier treatment credit.
        # It calls for expert reassessment at the 14-day boundary under user policy.
        if x.micro_response == "stable" and x.adverse_response_explained != "yes" and (days or 0) >= 14:
            blockers.append("UNCHANGED_SMEAR_AT_14_DAYS")
        if resistance and x.expert_review_completed != "yes":
            blockers.append("RESISTANCE_EXPERT_REVIEW_REQUIRED")
    if x.jurisdiction == "washington" and x.local_policy_minimum_days is None:
        ask("local_policy_minimum_days", "What current Washington/local TB-program release criterion applies? Supply the minimum and policy reference, or obtain local review.", True)
        blockers.append("WASHINGTON_POLICY_REVIEW")
    if x.setting in ("healthcare", "congregate_facility"):
        explanations.append("This output addresses community RIR only; facility airborne precautions require separate clearance. Setting does not force extensive restrictions.")

    critical = burden == "unknown" or community == "unknown" or any(
        b.startswith("CONFLICTING_") for b in blockers)
    if pediatric or excluded:
        target = lo = hi = 0
        level, status, remaining = "none", "no_restrictions_indicated", 0
        rules = ["S_PEDIATRIC_NON_ADULT_TYPE" if pediatric else "S_RESPIRATORY_TB_EXCLUDED"]
        blockers = []
        # No treatment/grade follow-up is needed to decide an established exemption.
        questions = []
    elif critical:
        level, status, remaining = None, "needs_input", None
        explanations.append("Missing or conflicting core grades need clarification; no automatic extensive classification was assigned.")
    elif not blockers and credit >= target:
        level, status, remaining = "none", "target_met", 0
        rules.append("L_TARGET_MET")
    else:
        if on_tx != "yes" or adverse:
            level = "moderate" if burden == "low" and community == "low" and not resistance else "extensive"
            rules.append("L_PRETREATMENT_OR_INEFFECTIVE")
            explanations.append("Prompt initiation or restoration of effective treatment is needed.")
        elif resistance and (not effective or credit < 5):
            level = "extensive"
            rules.append("L_EARLY_OR_UNCERTAIN_RESISTANT_TB")
        elif x.targeted_restrictions_feasible == "no" and community == "high":
            level = "extensive"
            rules.append("L_TARGETED_PRECAUTIONS_NOT_FEASIBLE")
        else:
            level = "moderate"
            rules.append("L_ON_TREATMENT_TARGETED_RESTRICTIONS")
        status = "conditional_reassessment" if blockers else "continue_to_target"
        remaining = None if blockers else max(0, target - credit)
    expert = bool(resistance or adverse or "UNCHANGED_SMEAR_AT_14_DAYS" in blockers or
                  (target is not None and target > 14) or "WASHINGTON_POLICY_REVIEW" in blockers)
    if x.days_since_isolation_started is not None and x.days_since_isolation_started > 14:
        expert = True  # referral, not an automatic extra isolation day
    if x.micro_response == "improving":
        explanations.append("Declining smear grade does not extend isolation beyond the target; smear conversion is not required.")
    if adverse or "UNCHANGED_SMEAR_AT_14_DAYS" in blockers or (resistance and blockers):
        explanations.append("The displayed days are the baseline planning target, not a release deadline. Response/resistance concerns require expert reassessment; any additional duration is not yet determined.")
    if not rapid_s and not (pediatric or excluded):
        explanations.append("Without an available GXP RIF-sensitive result, the planning target is at least 10 days; effectiveness is assessed separately.")
    labels = {None: None, "none": "no restriction", "moderate": "moderate restriction", "extensive": "extensive restriction"}
    explanations += [f"Assumption: {a['field']}={a['value']}. {a['reason']}" for a in assumptions]
    if target is not None and target > 0:
        explanations.append(f"Expected course: {target} effective-treatment days (anchor range {lo}-{hi}); credited {credit}. This is not a guaranteed calendar release date.")
    return {
        "ruleset_version": VERSION, "policy": "user_anchor_policy_2026_10_15",
        "restriction_level": labels[level], "expected_days_of_restrictions": target,
        "expected_days_range": {"minimum": lo, "maximum": hi},
        "expected_remaining_days": remaining, "decision_status": status,
        "credited_effective_treatment_days": credit,
        "duration_is_conditional": bool(blockers or assumptions or critical),
        "assumptions": assumptions, "questions": questions,
        "explanation": explanations, "rule_ids": rules,
        "release_blockers": list(dict.fromkeys(blockers)), "expert_consultation_recommended": expert,
        "normalized_assessment": {"pretreatment_burden": burden, "community_risk": community,
            "patient_harm": harm, "rifampin": rif, "resistance_concern": concern,
            "on_treatment": on_tx, "treatment_effective": effective,
            "effectiveness_basis": effectiveness_basis, "adherent": adherent,
            "tolerating": tolerant, "clinical_response": clinical},
        # Compatibility keys for v1 callers; the new canonical label is restriction_level.
        "isolation_level": level,
        "duration": {"clock": "effective_treatment_days", "conditional_target_total_days": target,
            "credited_effective_days": credit, "remaining_days_if_conditions_remain_met": remaining,
            "fixed_release_date": None, "reassess_within_days": None if level == "none" else (1 if blockers or critical else min(7, max(1, target-credit)))},
        "facility_clearance_granted": False,
        "llm_contract": "Report restriction_level and expected_days_of_restrictions together. Disclose assumptions, distinguish total from remaining days, and ask required questions. A null level with needs_input must never be converted to extensive. Do not treat assumptions as verified observations.",
    }


def input_schema() -> dict:
    props = {}
    for name, options in ENUMS.items():
        vals = list(options) + [None, ""]
        types = ["string", "null"]
        if options == TRI:
            vals += [True, False]
            types.append("boolean")
        if options == GRADES: vals.append("medium")
        if name == "gene_xpert": vals += ["detected RIF sensitive", "detected RIF resistant", "not available", "rif-s", "rif-r"]
        props[name] = {"type": types, "enum": vals}
    props.update({n: {"type": ["integer", "null"], "minimum": 0} for n in INTEGER_FIELDS})
    props.update({n: {"type": "string"} for n in ("individualized_reason", "local_policy_reason")})
    for alias, canonical in ALIASES.items():
        props[alias] = dict(props[canonical], description=f"Alias of {canonical}; do not send conflicting values.")
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "TB community isolation inputs v2",
            "type": "object", "additionalProperties": False, "properties": props,
            "description": "Minimal practical inputs: bacterial_burden, community_risk, gxp_status, treatment_days. Harm/adherence/tolerance/clinical-response defaults are disclosed. Missing grades yield questions, not extensive by default."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path)
    parser.add_argument("--schema", action="store_true")
    args = parser.parse_args()
    if args.schema:
        print(json.dumps(input_schema(), indent=2))
    elif args.input:
        try:
            result = evaluate(json.loads(args.input.read_text(encoding="utf-8-sig")))
        except (ValueError, TypeError) as e:
            parser.error(str(e))
        print(json.dumps(result, indent=2))
    else:
        parser.error("Supply an input JSON file or --schema")


if __name__ == "__main__":
    main()
