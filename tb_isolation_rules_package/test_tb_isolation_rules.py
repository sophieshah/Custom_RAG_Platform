import itertools
import unittest
from tb_isolation_rules import evaluate, Inputs

def patient(**kw):
    d=dict(bacterial_burden='low',community_risk='low',gxp_status='rif_sensitive',treatment_days=5)
    d.update(kw)
    return d

ANCHORS=[
 ('low','rif_sensitive','low','low',{},5,(5,5)),
 ('low','rif_sensitive','low','moderate',{},5,(5,5)),
 ('low','rif_sensitive','high','low',{},10,(10,10)),
 ('low','rif_sensitive','high','moderate',{},10,(10,10)),
 ('low','rif_sensitive','high','low',{'vulnerable_contacts':'yes'},14,(14,14)),
 ('moderate','rif_sensitive','low','low',{},7,(7,7)),
 ('moderate','rif_sensitive','low','moderate',{'patient_immunosuppressed':'yes','symptoms_resolved':'yes'},10,(10,10)),
 ('high','rif_sensitive','low','low',{},10,(10,14)),
 ('high','rif_sensitive','low','moderate',{},5,(5,10)),
 ('high','rif_sensitive','high','low',{},14,(14,14)),
 ('high','rif_sensitive','high','moderate',{'vulnerable_contacts':'yes'},10,(10,10)),
 ('high','rif_sensitive','high','moderate',{'congregate_return':'yes'},14,(14,14)),
 ('low','unavailable','low','low',{},10,(10,10)),
 ('low','unavailable','low','moderate',{},10,(10,10)),
 ('low','unavailable','high','low',{},14,(14,14)),
 ('low','unavailable','high','moderate',{},14,(14,14)),
 ('high','unavailable','low','low',{},14,(14,14)),
 ('high','unavailable','high','moderate',{},14,(14,14)),
 ('low','unavailable','high','high',{'age_years':8,'adult_type_disease':'no','treatment_days':0},0,(0,0)),
]

class RulesTest(unittest.TestCase):
 def test_anchors(self):
  for b,g,c,h,extra,total,span in ANCHORS:
   with self.subTest(b=b,g=g,c=c,h=h,extra=extra):
    r=evaluate(patient(bacterial_burden=b,gxp_status=g,community_risk=c,patient_harm=h,**extra))
    self.assertEqual(r['expected_days_of_restrictions'],total)
    self.assertEqual(tuple(r['expected_days_range'].values()),span)

 def test_minimal_input_and_defaults(self):
  r=evaluate(patient())
  self.assertEqual(r['restriction_level'],'no restriction')
  defaults={a['field']:a['value'] for a in r['assumptions']}
  for k,v in {'patient_harm':'moderate','resistance_suspected':'no','adherence_verified':'yes','tolerance_adequate':'yes','clinical_response':'improving','effectiveness_assessed':'yes'}.items(): self.assertEqual(defaults[k],v)

 def test_setting_never_forces_extensive(self):
  for s in (None,'unknown','community','healthcare','congregate_facility'):
   r=evaluate(patient(setting=s))
   self.assertEqual(r['restriction_level'],'no restriction')
   self.assertFalse(r['facility_clearance_granted'])

 def test_missing_core_asks(self):
  for d in ({},patient(bacterial_burden=None),patient(community_risk=None)):
   r=evaluate(d)
   self.assertEqual(r['decision_status'],'needs_input')
   self.assertIsNone(r['restriction_level'])
   self.assertIsNone(r['expected_days_of_restrictions'])

 def test_partial_burden(self):
  for raw,grade in [({'smear':'negative'},'low'),({'smear':'1+'},'moderate'),({'smear':'3+'},'high'),({'cavitation':'yes'},'high'),({'cough':'frequent'},'moderate'),({'cavitation':'no','cough':'none'},'low')]:
   self.assertEqual(evaluate(patient(bacterial_burden='unknown',**raw))['normalized_assessment']['pretreatment_burden'],grade)

 def test_conflicts_ask(self):
  for extra in ({'smear':'3+'},{'rifampin':'resistant'},{'on_treatment':'no'}):
   self.assertEqual(evaluate(patient(**extra))['decision_status'],'needs_input')

 def test_community_inference(self):
  for extra,c in [({'new_contacts':'none'},'low'),({'vulnerable_contacts':'yes'},'high'),({'new_contacts':'many','exposure_duration':'recurrent','exposure_environment':'well_ventilated'},'moderate')]:
   self.assertEqual(evaluate(patient(community_risk='unknown',**extra))['normalized_assessment']['community_risk'],c)

 def test_domain_harm(self):
  self.assertEqual(evaluate(patient(housing_harm='high'))['normalized_assessment']['patient_harm'],'high')
  self.assertEqual(evaluate(patient(employment_harm='low'))['normalized_assessment']['patient_harm'],'low')

 def test_adverse_overrides_assumptions(self):
  for extra in ({'adherent':False},{'tolerating':False},{'clinical_response':'no improvement'},{'treatment_effective':False},{'regimen_appropriate':'no'},{'lab_supports_regimen':'no'},{'micro_response':'rising'}):
   r=evaluate(patient(treatment_days=20,**extra))
   self.assertNotEqual(r['restriction_level'],'no restriction')
   self.assertEqual(r['credited_effective_treatment_days'],0)
   self.assertTrue(r['expert_consultation_recommended'])

 def test_unknown_treatment(self):
  for extra in ({'treatment_days':None},{'treatment_days':None,'on_treatment':'yes'}):
   r=evaluate(patient(**extra))
   self.assertEqual(r['credited_effective_treatment_days'],0)
   self.assertIsNone(r['expected_remaining_days'])
   self.assertEqual(r['expected_days_of_restrictions'],5)

 def test_pretreatment_levels(self):
  self.assertEqual(evaluate(patient(treatment_days=0))['restriction_level'],'moderate restriction')
  self.assertEqual(evaluate(patient(treatment_days=0,bacterial_burden='high'))['restriction_level'],'extensive restriction')

 def test_unknown_gxp_not_automatic_extensive(self):
  r=evaluate(patient(gxp_status='unavailable'))
  self.assertEqual(r['restriction_level'],'moderate restriction')
  self.assertEqual(r['credited_effective_treatment_days'],0)
  self.assertEqual(r['expected_days_of_restrictions'],10)
  self.assertIsNone(r['expected_remaining_days'])

 def test_unknown_gxp_explicit_effectiveness(self):
  self.assertEqual(evaluate(patient(gxp_status='unavailable',treatment_effective=True,treatment_days=10))['restriction_level'],'no restriction')
  r=evaluate(patient(gxp_status='unavailable',lab_supports_regimen='yes',regimen_appropriate='yes'))
  self.assertGreaterEqual(r['expected_days_of_restrictions'],10)

 def test_resistance(self):
  r=evaluate(patient(drug_resistance_concern=True,treatment_days=20))
  self.assertEqual(r['restriction_level'],'extensive restriction')
  self.assertEqual(r['credited_effective_treatment_days'],0)
  r=evaluate(patient(gxp_status='rif_resistant',treatment_effective=True,expert_review_completed='yes',treatment_days=14))
  self.assertEqual(r['restriction_level'],'no restriction')
  self.assertFalse(any(a['field']=='resistance_suspected' for a in r['assumptions']))

 def test_smear_trajectories(self):
  for day in (14,15,30):
   r=evaluate(patient(bacterial_burden='high',community_risk='high',patient_harm='low',treatment_days=day,micro_response='declining'))
   self.assertEqual(r['restriction_level'],'no restriction')
   self.assertEqual(r['expected_days_of_restrictions'],14)
  r=evaluate(patient(treatment_days=14,micro_response='unchanged'))
  self.assertEqual(r['restriction_level'],'moderate restriction')
  self.assertIn('UNCHANGED_SMEAR_AT_14_DAYS',r['release_blockers'])
  self.assertIsNone(r['expected_remaining_days'])

 def test_prolonged_isolation_not_blanket_gate(self):
  r=evaluate(patient(treatment_days=15,days_since_isolation_started=20))
  self.assertEqual(r['restriction_level'],'no restriction')
  self.assertTrue(r['expert_consultation_recommended'])

 def test_case5c(self):
  base=patient(bacterial_burden='moderate',patient_immunosuppressed='yes',treatment_days=10)
  self.assertEqual(evaluate(base)['restriction_level'],'moderate restriction')
  self.assertEqual(evaluate(dict(base,symptoms_resolved='yes'))['restriction_level'],'no restriction')
  self.assertEqual(evaluate(dict(base,symptoms_resolved='no'))['expected_days_of_restrictions'],14)
  self.assertEqual(evaluate(dict(base,treatment_days=14,symptoms_resolved='no'))['restriction_level'],'no restriction')

 def test_child_exception(self):
  base=patient(age_years=8,adult_type_disease='no',treatment_days=None,gxp_status='unavailable',community_risk='unknown')
  self.assertEqual(evaluate(base)['restriction_level'],'no restriction')
  self.assertEqual(evaluate(base)['expected_days_of_restrictions'],0)
  for extra in ({'age_years':10},{'adult_type_disease':'unknown'},{'smear':'positive'},{'cavitation':'yes'}): self.assertNotEqual(evaluate(dict(base,**extra))['restriction_level'],'no restriction')

 def test_washington(self):
  r=evaluate(patient(jurisdiction='WA'))
  self.assertIn('WASHINGTON_POLICY_REVIEW',r['release_blockers'])
  self.assertEqual(r['restriction_level'],'moderate restriction')
  r=evaluate(patient(jurisdiction='WA',local_policy_minimum_days=21,local_policy_reason='Clinician-supplied example protocol'))
  self.assertEqual(r['expected_days_of_restrictions'],21)

 def test_documented_extension(self):
  self.assertEqual(evaluate(patient(individualized_minimum_days=18,individualized_reason='Extenuating circumstance'))['expected_days_of_restrictions'],18)
  with self.assertRaises(ValueError): evaluate(patient(individualized_minimum_days=18))

 def test_boundaries(self):
  for target,extra in [(5,{}),(7,{'bacterial_burden':'moderate'}),(10,{'community_risk':'high'}),(14,{'community_risk':'high','bacterial_burden':'high','patient_harm':'low'})]:
   for day in (target-1,target,target+1): self.assertEqual(evaluate(patient(treatment_days=day,**extra))['restriction_level']=='no restriction',day>=target)

 def test_legacy(self):
  self.assertEqual(evaluate(Inputs(pretreatment_burden='low',community_risk='low',rifampin='susceptible',uninterrupted_effective_days=5))['restriction_level'],'no restriction')

 def test_aliases(self):
  r=evaluate(patient(bacterial_burden='medium',gxp_status='detected RIF sensitive',patient_harm=None))
  self.assertEqual(r['expected_days_of_restrictions'],7)

 def test_validation(self):
  for data in ({'treatment_days':True},{'treatment_days':-1},{'treatment_days':2.5},{'typo':1},{'bacterial_burden':'low','pretreatment_burden':'high'},{'treatment_days':5,'uninterrupted_effective_days':10}):
   with self.subTest(data=data),self.assertRaises(ValueError): evaluate(data)

 def test_576_combinations(self):
  count=0
  for b,c,h,g,d in itertools.product(('low','moderate','high'),('low','moderate','high'),('low','moderate','high','unknown'),('rif_sensitive','unavailable'),(0,4,5,7,10,13,14,15)):
   r=evaluate(patient(bacterial_burden=b,community_risk=c,patient_harm=h,gxp_status=g,treatment_days=d));count+=1
   self.assertIn(r['restriction_level'],('no restriction','moderate restriction','extensive restriction'))
   self.assertLessEqual(r['expected_days_of_restrictions'],14)
   if g=='unavailable': self.assertGreaterEqual(r['expected_days_of_restrictions'],10)
   if r['restriction_level']=='no restriction':
    self.assertFalse(r['release_blockers'])
    self.assertGreaterEqual(r['credited_effective_treatment_days'],r['expected_days_of_restrictions'])
   if r['expected_days_of_restrictions']==5:
    self.assertEqual(c,'low'); self.assertIn(b,('low','high'))
  self.assertEqual(count,576)

if __name__=='__main__': unittest.main()
