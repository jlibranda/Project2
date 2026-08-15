(function () {
  'use strict';

  var remoteHosts = /(?:vercel\.app|chatgpt\.site)$/i;
  var apiHost = remoteHosts.test(location.hostname) ? 'https://sproutripple-ph-production.up.railway.app' : location.origin;
  var apiRoot = apiHost + '/api';
  window.apiHost = apiHost;
  var token = sessionStorage.getItem('sproutripple_session') || '';
  var stateVersion = 0;
  var saveTimer = null;
  var saving = false;
  var saveAgain = false;
  var lastSavedPayload = '';
  var lastAttemptedPayload = '';

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
      fieldConfig:FIELD_CONFIG,incomeTypes:INCOME_TYPES,attendanceAdjustments:ATTENDANCE_ADJ,attendancePolicy:ATTENDANCE_POLICY,
      overtimeRates:OT_RATES,payrollGroups:PAYROLL_GROUPS,payPeriods:PAY_PERIODS,
      payrollAdjustments:PAYROLL_ADJ,finalPayList:FINAL_PAY_LIST,payrollAudit:PAYROLL_AUDIT,securityAudit:SECURITY_AUDIT,
      governmentRates:GOVT_RATES,birTaxVersions:BIR_TAX_VERSIONS,platformClients:PLATFORM_CLIENTS,
      enterprise:window.collectEnterpriseState?window.collectEnterpriseState():null,
      payrollGovernance:window.collectPayrollGovernanceState?window.collectPayrollGovernanceState():null,
      zk:{userMapping:(typeof ZK!=='undefined'&&ZK.userMapping)||{},realtimeEnabled:(typeof ZK!=='undefined'&&!!ZK.realtimeEnabled),connectionOverride:(typeof ZK!=='undefined'&&ZK.connectionOverride)||{address:'',port:'',https:false},punchBuffer:(typeof ZK!=='undefined'&&ZK.punchBuffer)||{beforeMinutes:120,afterMinutes:480}}
    };
  }

  function hydrate(saved) {
    if(!saved)return;
    replaceArray(ORG,saved.org);if(saved.lookups)LOOKUPS=saved.lookups;
    replaceArray(USERS,saved.users);replaceArray(ATT,saved.attendance);replaceArray(LEAVES,saved.leaves);
    replaceArray(LOANS,saved.loans);replaceArray(PAYROLLS,saved.payrolls);if(saved.payrollDraft)PAYROLL_DRAFT=saved.payrollDraft;
    replaceArray(CANDIDATES,saved.candidates);replaceArray(PERF,saved.performance);replaceArray(ONBOARD,saved.onboarding);
    replaceArray(ACCESS_LEVELS,saved.accessLevels);replaceArray(CHANGE_REQUESTS,saved.changeRequests);
    replaceArray(BUNDY_LOGS,saved.bundyLogs);replaceArray(OFFICE_ZONES,saved.officeZones);
    // Merge instead of replacing outright: a feature module (enterprise.js) may have already
    // seeded a default onto COMPANY (e.g. leaveTypes) before this ever ran, on a save that
    // predates that feature and therefore has no key for it at all. Object.assign only copies
    // keys saved.company actually has, so an unsaved default like that survives hydration
    // instead of silently disappearing the moment a user logs in.
    if(saved.company)Object.assign(COMPANY,saved.company);
    if(saved.employeeNumberConfig)EMP_NUM_CONFIG=saved.employeeNumberConfig;if(saved.statutoryConfig)STATUTORY_CONFIG=saved.statutoryConfig;
    if(saved.approvalConfig)APPROVAL_CONFIG=saved.approvalConfig;if(saved.fieldConfig)FIELD_CONFIG=saved.fieldConfig;
    replaceArray(INCOME_TYPES,saved.incomeTypes);if(saved.attendanceAdjustments)ATTENDANCE_ADJ=saved.attendanceAdjustments;
    if(saved.attendancePolicy)Object.assign(ATTENDANCE_POLICY,saved.attendancePolicy);
    replaceArray(OT_RATES,saved.overtimeRates);replaceArray(PAYROLL_GROUPS,saved.payrollGroups);replaceArray(PAY_PERIODS,saved.payPeriods);
    replaceArray(PAYROLL_ADJ,saved.payrollAdjustments);replaceArray(FINAL_PAY_LIST,saved.finalPayList);replaceArray(PAYROLL_AUDIT,saved.payrollAudit);replaceArray(SECURITY_AUDIT,saved.securityAudit);
    if(saved.governmentRates)GOVT_RATES=saved.governmentRates;replaceArray(BIR_TAX_VERSIONS,saved.birTaxVersions);replaceArray(PLATFORM_CLIENTS,saved.platformClients);
    if(window.applyEnterpriseState)window.applyEnterpriseState(saved.enterprise);
    if(window.applyPayrollGovernanceState)window.applyPayrollGovernanceState(saved.payrollGovernance);
    if(saved.zk&&typeof ZK!=='undefined'){
      ZK.userMapping=saved.zk.userMapping||{};
      ZK.realtimeEnabled=!!saved.zk.realtimeEnabled;
      ZK.connectionOverride=saved.zk.connectionOverride||{address:'',port:'',https:false};
      ZK.punchBuffer=saved.zk.punchBuffer||{beforeMinutes:120,afterMinutes:480};
      if(ZK.realtimeEnabled&&typeof startRealtime==='function')startRealtime();
    }
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

  window.apiRequest=request;

  window.connectDatabaseAfterLogin=async function(email,password){
    var result=await request('/auth/login',{method:'POST',body:JSON.stringify({email:email,password:password})});
    if(!result.token)throw new Error('The deployed data service has not been connected yet.');
    token=result.token;stateVersion=result.version||0;sessionStorage.setItem('sproutripple_session',token);
    if(result.state){hydrate(result.state);lastSavedPayload=JSON.stringify(snapshot());}
    else if(result.persistence)await saveNow();
  };
  // A real client's company-admin identity (platform_clients.admin_email) has no matching
  // USERS[] record — only real employees do — so callers that only know how to look someone
  // up by scanning USERS need this as a fallback: the backend already authenticated them
  // (that's the only way a valid token exists), this just recovers who they are.
  window.getSessionIdentity=function(){return token?decodeToken(token):null;};

  // ── God Admin entering/exiting a real client's own session (Enter Portal) ──
  // Distinct from a normal login: the God Admin's own session (token/version/last-saved-
  // snapshot) is parked so it can be restored exactly on exit, rather than requiring the
  // password of the client being entered.
  var _parkedSession=null;
  window.enterImpersonatedSession=function(newToken,newState,newVersion){
    _parkedSession={token:token,stateVersion:stateVersion,lastSavedPayload:lastSavedPayload};
    if(window.resetEnterpriseState)window.resetEnterpriseState();
    if(window.resetPayrollGovernanceState)window.resetPayrollGovernanceState();
    token=newToken;stateVersion=newVersion||0;sessionStorage.setItem('sproutripple_session',token);
    if(newState)hydrate(newState);
    lastSavedPayload=JSON.stringify(snapshot());
  };
  window.exitImpersonatedSession=function(){
    if(!_parkedSession)return;
    token=_parkedSession.token;stateVersion=_parkedSession.stateVersion;lastSavedPayload=_parkedSession.lastSavedPayload;
    sessionStorage.setItem('sproutripple_session',token);
    _parkedSession=null;
  };

  async function saveNow(){
    if(!token)return;
    if(saving){saveAgain=true;return;}
    saving=true;
    try{
      var state=snapshot(),payload=JSON.stringify(state);
      if(payload===lastSavedPayload||payload===lastAttemptedPayload)return;
      lastAttemptedPayload=payload;
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
  // Never autosave while a God Admin is browsing a pre-seeded sample/demo client that has no
  // backend tenant of its own (Platform > Clients, any client other than id 1 / the real
  // company, with no tenantKey). That view swaps the live USERS/ATT/etc. arrays to that demo
  // client's own (often empty) sample data purely for in-browser display — it was never wired
  // to real per-tenant storage. Autosaving from inside that swapped, fake state would silently
  // overwrite the real company's actual data the moment a render fires (this is what happened
  // once already: entering a demo client with no seeded employees replaced the live USERS
  // array with an empty one, which the very next render then saved for real).
  //
  // A REAL client (tenantKey set) is different: entering one (enterImpersonatedSession) swaps
  // the active session token to that tenant's own, so an autosave here correctly lands on
  // THAT tenant's own app_state row, not the real company's — this is exactly what should
  // happen while editing a real client's data on their behalf.
  render=function(){
    baseRender();
    var activeClient=(typeof activeClientId!=='undefined'&&activeClientId&&activeClientId!==1&&typeof PLATFORM_CLIENTS!=='undefined')
      ?PLATFORM_CLIENTS.find(function(c){return c.id===activeClientId;})
      :null;
    var browsingLocalDemoClient=!!(activeClient&&!activeClient.tenantKey);
    if(user&&token&&!browsingLocalDemoClient)window.queueDatabaseSave();
  };

  // A page refresh previously always dropped back to the login screen even with a
  // still-valid session token sitting in sessionStorage. Decode the token (it's just
  // signed, not encrypted) to recover identity, then re-hydrate state and resume.
  function base64UrlDecode(str){
    str=str.replace(/-/g,'+').replace(/_/g,'/');
    while(str.length%4)str+='=';
    return decodeURIComponent(atob(str).split('').map(function(c){return '%'+('00'+c.charCodeAt(0).toString(16)).slice(-2);}).join(''));
  }
  function decodeToken(t){
    try{return JSON.parse(base64UrlDecode(t.split('.')[0]));}catch(e){return null;}
  }
  async function restoreSession(){
    if(!token){sessionRestoring=false;return;}
    var payload=decodeToken(token);
    if(!payload||!payload.exp||payload.exp<=Date.now()){
      token='';sessionStorage.removeItem('sproutripple_session');
      sessionRestoring=false;render();return;
    }
    try{
      var result=await request('/state');
      stateVersion=result.version||0;
      if(result.state){hydrate(result.state);lastSavedPayload=JSON.stringify(snapshot());}
      if(payload.role==='platform'){
        isPlatformAdmin=true;
        user={id:0,name:'God Admin',email:payload.sub,role:'platform',initials:'GA'};
        view='platform';
      }else{
        var match=USERS.find(function(u){return u.email===payload.sub;});
        if(match){
          user=match;view='dashboard';
          if(typeof checkOffboarding==='function')checkOffboarding();
          if(typeof window.autoRunLeaveAccrual==='function')window.autoRunLeaveAccrual();
        }else if(payload.role==='admin'){
          // A real client's own company-admin login — no USERS[] record to match (that's only
          // for actual employees), but the token proves the backend already authenticated them.
          user={id:0,name:(COMPANY.name||'Company')+' Admin',email:payload.sub,role:'admin',initials:(COMPANY.initials||'A')};
          view='dashboard';
        }else{
          sessionRestoring=false;render();return; // identity no longer resolvable — fall back to the login screen
        }
      }
      tab=0;modal=null;
      sessionRestoring=false;
      render();
    }catch(error){
      token='';stateVersion=0;sessionStorage.removeItem('sproutripple_session');
      sessionRestoring=false;render();
    }
  }
  restoreSession();
}());
