(function () {
  'use strict';

  var remoteHosts = /(?:vercel\.app|chatgpt\.site)$/i;
  var apiRoot = remoteHosts.test(location.hostname) ? 'https://sproutripple-ph-production.up.railway.app/api' : '/api';
  var token = sessionStorage.getItem('sproutripple_session') || '';
  var stateVersion = 0;
  var saveTimer = null;
  var saving = false;
  var saveAgain = false;
  var lastSavedPayload = '';

  function replaceArray(target, value) {
    if (!Array.isArray(value)) return;
    target.length = 0;
    target.push.apply(target, value);
  }

  function snapshot() {
    return {
      schemaVersion:1,org:ORG,lookups:LOOKUPS,users:USERS,
      attendance:ATT,leaves:LEAVES,loans:LOANS,payrolls:PAYROLLS,payrollDraft:PAYROLL_DRAFT,
      candidates:CANDIDATES,performance:PERF,onboarding:ONBOARD,accessLevels:ACCESS_LEVELS,
      changeRequests:CHANGE_REQUESTS,bundyLogs:BUNDY_LOGS,officeZones:OFFICE_ZONES,company:COMPANY,
      employeeNumberConfig:EMP_NUM_CONFIG,statutoryConfig:STATUTORY_CONFIG,approvalConfig:APPROVAL_CONFIG,
      fieldConfig:FIELD_CONFIG,incomeTypes:INCOME_TYPES,attendanceAdjustments:ATTENDANCE_ADJ,
      overtimeRates:OT_RATES,payrollGroups:PAYROLL_GROUPS,payPeriods:PAY_PERIODS,
      payrollAdjustments:PAYROLL_ADJ,finalPayList:FINAL_PAY_LIST,payrollAudit:PAYROLL_AUDIT,securityAudit:SECURITY_AUDIT,
      governmentRates:GOVT_RATES,birTaxVersions:BIR_TAX_VERSIONS,platformClients:PLATFORM_CLIENTS,
      enterprise:window.collectEnterpriseState?window.collectEnterpriseState():null,
      payrollGovernance:window.collectPayrollGovernanceState?window.collectPayrollGovernanceState():null
    };
  }

  function hydrate(saved) {
    if(!saved)return;
    replaceArray(ORG,saved.org);if(saved.lookups)LOOKUPS=saved.lookups;
    replaceArray(USERS,saved.users);replaceArray(ATT,saved.attendance);replaceArray(LEAVES,saved.leaves);
    replaceArray(LOANS,saved.loans);replaceArray(PAYROLLS,saved.payrolls);if(saved.payrollDraft)PAYROLL_DRAFT=saved.payrollDraft;
    replaceArray(CANDIDATES,saved.candidates);replaceArray(PERF,saved.performance);replaceArray(ONBOARD,saved.onboarding);
    replaceArray(ACCESS_LEVELS,saved.accessLevels);replaceArray(CHANGE_REQUESTS,saved.changeRequests);
    replaceArray(BUNDY_LOGS,saved.bundyLogs);replaceArray(OFFICE_ZONES,saved.officeZones);if(saved.company)COMPANY=saved.company;
    if(saved.employeeNumberConfig)EMP_NUM_CONFIG=saved.employeeNumberConfig;if(saved.statutoryConfig)STATUTORY_CONFIG=saved.statutoryConfig;
    if(saved.approvalConfig)APPROVAL_CONFIG=saved.approvalConfig;if(saved.fieldConfig)FIELD_CONFIG=saved.fieldConfig;
    replaceArray(INCOME_TYPES,saved.incomeTypes);if(saved.attendanceAdjustments)ATTENDANCE_ADJ=saved.attendanceAdjustments;
    replaceArray(OT_RATES,saved.overtimeRates);replaceArray(PAYROLL_GROUPS,saved.payrollGroups);replaceArray(PAY_PERIODS,saved.payPeriods);
    replaceArray(PAYROLL_ADJ,saved.payrollAdjustments);replaceArray(FINAL_PAY_LIST,saved.finalPayList);replaceArray(PAYROLL_AUDIT,saved.payrollAudit);replaceArray(SECURITY_AUDIT,saved.securityAudit);
    if(saved.governmentRates)GOVT_RATES=saved.governmentRates;replaceArray(BIR_TAX_VERSIONS,saved.birTaxVersions);replaceArray(PLATFORM_CLIENTS,saved.platformClients);
    if(window.applyEnterpriseState)window.applyEnterpriseState(saved.enterprise);
    if(window.applyPayrollGovernanceState)window.applyPayrollGovernanceState(saved.payrollGovernance);
    nAtt=ATT.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nLeave=LEAVES.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nLoan=LOANS.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nEmp=USERS.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nPay=PAYROLLS.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nPayGroup=PAYROLL_GROUPS.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nPayPeriod=PAY_PERIODS.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nAdj=PAYROLL_ADJ.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nFP=FINAL_PAY_LIST.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    nSecurityAudit=SECURITY_AUDIT.reduce(function(max,item){return Math.max(max,item.id||0);},0)+1;
    document.title=COMPANY.name+' — HR & Payroll';
  }

  async function request(path,options){
    var headers=Object.assign({'Content-Type':'application/json'},options&&options.headers||{});
    if(token)headers.Authorization='Bearer '+token;
    var response=await fetch(apiRoot+path,Object.assign({},options||{},{headers:headers}));
    var result=await response.json().catch(function(){return {};});
    if(!response.ok){var error=new Error(result.error||'The data service returned an error.');error.status=response.status;throw error;}
    return result;
  }

  window.connectDatabaseAfterLogin=async function(email,password){
    var result=await request('/auth/login',{method:'POST',body:JSON.stringify({email:email,password:password})});
    if(!result.token)throw new Error('The deployed data service has not been connected yet.');
    token=result.token;stateVersion=result.version||0;sessionStorage.setItem('sproutripple_session',token);
    if(result.state){hydrate(result.state);lastSavedPayload=JSON.stringify(snapshot());}
    else if(result.persistence)await saveNow();
  };

  async function saveNow(){
    if(!token)return;
    if(saving){saveAgain=true;return;}
    saving=true;
    try{
      var state=snapshot(),payload=JSON.stringify(state);
      if(payload===lastSavedPayload)return;
      var result=await request('/state',{method:'PUT',body:JSON.stringify({version:stateVersion,state:state})});
      stateVersion=result.version;
      lastSavedPayload=payload;
    }catch(error){
      if(error.status===409)toast('This data changed in another session. Please reload before editing further.','warning');
      else toast('Changes could not be saved to the database. '+error.message,'warning');
    }finally{saving=false;if(saveAgain){saveAgain=false;window.queueDatabaseSave();}}
  }

  window.queueDatabaseSave=function(){if(!token)return;clearTimeout(saveTimer);saveTimer=setTimeout(saveNow,700);};
  window.disconnectDatabaseSession=function(){token='';stateVersion=0;lastSavedPayload='';sessionStorage.removeItem('sproutripple_session');};

  var baseRender=render;
  render=function(){baseRender();if(user&&token)window.queueDatabaseSave();};
}());
