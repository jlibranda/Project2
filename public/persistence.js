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
      savedReports:SAVED_REPORTS,
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
    if(saved.company){
      Object.assign(COMPANY,saved.company);
      // Identity fields are the one place that partial-merge behavior actively hurts: a tenant
      // whose stored record predates the logo field (or genuinely has none of its own) has no
      // 'logo' key in saved.company at all, so Object.assign leaves COMPANY.logo exactly as it
      // was before this call -- a previous tenant's cached branding, or the platform's own AURA
      // default -- instead of correctly falling back to blank/initials for THIS tenant. Force
      // these three to authoritatively reflect what was actually just hydrated (or its absence)
      // every time, so a real client's own topbar/login never inherits someone else's mark.
      COMPANY.logo=saved.company.logo||null;
      COMPANY.name=saved.company.name||'AURA';
      COMPANY.initials=saved.company.initials||'A';
    }
    if(saved.employeeNumberConfig)EMP_NUM_CONFIG=saved.employeeNumberConfig;if(saved.statutoryConfig)STATUTORY_CONFIG=saved.statutoryConfig;
    if(saved.approvalConfig)APPROVAL_CONFIG=saved.approvalConfig;if(saved.fieldConfig)FIELD_CONFIG=saved.fieldConfig;
    replaceArray(INCOME_TYPES,saved.incomeTypes);if(saved.attendanceAdjustments)ATTENDANCE_ADJ=saved.attendanceAdjustments;
    if(saved.attendancePolicy)Object.assign(ATTENDANCE_POLICY,saved.attendancePolicy);
    replaceArray(OT_RATES,saved.overtimeRates);replaceArray(PAYROLL_GROUPS,saved.payrollGroups);replaceArray(PAY_PERIODS,saved.payPeriods);
    replaceArray(PAYROLL_ADJ,saved.payrollAdjustments);replaceArray(FINAL_PAY_LIST,saved.finalPayList);replaceArray(PAYROLL_AUDIT,saved.payrollAudit);replaceArray(SECURITY_AUDIT,saved.securityAudit);
    if(saved.governmentRates)GOVT_RATES=saved.governmentRates;replaceArray(BIR_TAX_VERSIONS,saved.birTaxVersions);replaceArray(PLATFORM_CLIENTS,saved.platformClients);
    replaceArray(SAVED_REPORTS,saved.savedReports);
    // One-time migration: 'teamview' was added to the module catalog after some clients'
    // module lists were already persisted, so replaceArray above just restored those clients
    // to their old, teamview-less snapshot. Backfill it in so existing tenants aren't stuck
    // forever on a module that didn't exist when their record was first saved.
    PLATFORM_CLIENTS.forEach(function(c){
      if(c.modules&&Array.isArray(c.modules)&&c.modules.indexOf('teamview')===-1)c.modules.push('teamview');
    });
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
    // applyTheme() (index.html) is otherwise only ever called from the Company Settings page
    // itself (live preview / save), so a saved custom theme never actually painted the app until
    // someone happened to revisit that page in the same session -- every fresh load/restore
    // silently fell back to the default indigo CSS instead of the tenant's own accent color.
    // Re-apply it here so it's live from the moment this tenant's state is hydrated.
    if(typeof window.applyTheme==='function')window.applyTheme(COMPANY.themeKey,COMPANY.accentHex);
  }

  async function request(path,options){
    var headers=Object.assign({'Content-Type':'application/json'},options&&options.headers||{});
    if(token)headers.Authorization='Bearer '+token;
    var response=await fetch(apiRoot+path,Object.assign({},options||{},{headers:headers}));
    var result=await response.json().catch(function(){return {};});
    if(!response.ok){var error=new Error(result.error||'The data service returned an error.');error.status=response.status;error.body=result;throw error;}
    return result;
  }

  window.apiRequest=request;
  // Attendance/leave decision endpoints (server.js's POST /api/attendance/:id/decision etc.)
  // mutate app_state through their own transaction, outside the normal snapshot()/PUT /api/state
  // autosave path -- the version they bump it to is returned in their response, but this
  // module's own stateVersion tracker has no way to know that happened unless told. Without this,
  // the very next regular autosave after a successful decision call would submit the now-stale
  // stateVersion and get rejected with 409, surfacing a confusing "reload before editing further"
  // toast for something that isn't actually a conflict. Call this with the version such an
  // endpoint's response returns right after a successful call.
  window.syncStateVersion=function(v){if(typeof v==='number'&&v>stateVersion)stateVersion=v;};
  // Read-only counterpart -- the payroll lifecycle endpoints (POST /api/payroll-runs/:id/approve
  // etc.) accept an expectedVersion so the server can reject a call made against a state the
  // caller's own session no longer has current, without requiring the client to duplicate this
  // module's own private version tracking.
  window.getStateVersion=function(){return stateVersion;};

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

  // The pre-hydrate "quick paint" loading screen (renderLoading(), index.html) reads whatever
  // localStorage['sr_company_brand_'+tenantKey] already holds, synchronously, before this
  // file's own async restoreSession() below has fetched anything -- so the very first time a
  // given tenant is ever entered on this browser, that key doesn't exist yet, and the loading
  // screen falls back to the neutral AURA default for that one load even though the tenant
  // itself (Gostoso Cafe, say) is about to render correctly moments later. index.html's own
  // render() already writes this cache on every render, but that first write doesn't land until
  // the next render() cycle -- calling this immediately after hydrate() below closes that gap
  // one render sooner, so a refresh right after entering (or right after this restore) already
  // has something real to read.
  function cacheBrandFor(newToken){
    try{
      var payload=decodeToken(newToken);
      if(payload&&payload.tenantKey)localStorage.setItem('sr_company_brand_'+payload.tenantKey,JSON.stringify({logo:COMPANY.logo,name:COMPANY.name,initials:COMPANY.initials}));
    }catch(e){}
  }

  // ── God Admin entering/exiting a real client's own session (Enter Portal) ──
  // Distinct from a normal login: the God Admin's own session (token/version/last-saved-
  // snapshot) is parked so it can be restored exactly on exit, rather than requiring the
  // password of the client being entered. Also mirrored into sessionStorage (not just this
  // in-memory var) because a page reload while impersonating must still be able to find its
  // way back — restoreSession() below reads this same key to recover from exactly that case.
  var _parkedSession=null;
  var PARKED_SESSION_KEY='sproutripple_parked_session';
  window.enterImpersonatedSession=function(newToken,newState,newVersion){
    _parkedSession={token:token,stateVersion:stateVersion,lastSavedPayload:lastSavedPayload};
    try{sessionStorage.setItem(PARKED_SESSION_KEY,JSON.stringify(_parkedSession));}catch(e){}
    if(window.resetEnterpriseState)window.resetEnterpriseState();
    if(window.resetPayrollGovernanceState)window.resetPayrollGovernanceState();
    token=newToken;stateVersion=newVersion||0;sessionStorage.setItem('sproutripple_session',token);
    if(newState)hydrate(newState);
    lastSavedPayload=JSON.stringify(snapshot());
    cacheBrandFor(newToken);
  };
  // Restores God Admin's own session and re-fetches its state fresh from the server, rather
  // than trusting index.html's in-memory _savedAppState snapshot — that plain JS variable does
  // not survive a page reload, but exiting has to work identically whether or not the page
  // reloaded while impersonating. Returns false if there was no parked session to restore
  // (e.g. exiting a local-only demo client, which never parks one).
  window.exitImpersonatedSession=async function(){
    if(!_parkedSession){
      try{var stored=sessionStorage.getItem(PARKED_SESSION_KEY);if(stored)_parkedSession=JSON.parse(stored);}catch(e){}
    }
    if(!_parkedSession)return false;
    token=_parkedSession.token;stateVersion=_parkedSession.stateVersion;lastSavedPayload=_parkedSession.lastSavedPayload;
    sessionStorage.setItem('sproutripple_session',token);
    try{sessionStorage.removeItem(PARKED_SESSION_KEY);}catch(e){}
    _parkedSession=null;
    try{
      var result=await request('/state');
      stateVersion=result.version||0;
      if(result.state){hydrate(result.state);lastSavedPayload=JSON.stringify(snapshot());}
      // Same reasoning as restoreSession()'s role==='platform' branch: exiting back to God
      // Admin's own parked token re-hydrates from the same shared /state.company row a fresh
      // platform restore would, so it needs the identical forced-AURA reset -- otherwise exiting
      // a client silently leaves whatever that row's logo/name happen to be on screen instead of
      // the neutral platform identity.
      var exitedPayload=decodeToken(token);
      if(exitedPayload&&exitedPayload.role==='platform'){
        COMPANY.name='AURA';COMPANY.tagline='People Operations Cloud';COMPANY.initials='A';
        COMPANY.logo=(typeof AURA_MARK!=='undefined')?AURA_MARK:null;
        // Same leak this whole identity block exists to close, but for the theme color: the
        // shared /state.company row hydrate() just re-read from can carry client 1's own chosen
        // accent, which would otherwise paint God Admin's console the moment applyTheme() (now
        // called from hydrate()) picks it up.
        COMPANY.themeKey='indigo';COMPANY.accentHex='#4f46e5';
        if(typeof window.applyTheme==='function')window.applyTheme('indigo','#4f46e5');
      }
    }catch(e){}
    return true;
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
      // Present only for an employee-role session (see PUT /api/state): the server only ever
      // persists that session's own records in a few self-service slices, silently discarding
      // anything else the payload tried to change -- so what actually landed can differ from
      // what we asked to save. Re-hydrate from it so the UI never shows something as "saved"
      // that didn't actually persist. Skipped when the two are already identical (the common
      // case -- a plain leave/attendance filing round-trips unchanged), so a routine autosave
      // never triggers an unnecessary re-render that could disrupt whatever the user is doing
      // elsewhere on the page right now.
      if(result.state){
        var actualPayload=JSON.stringify(result.state);
        if(actualPayload!==payload){
          hydrate(result.state);
          lastSavedPayload=JSON.stringify(snapshot());
          render();
        }else{
          lastSavedPayload=payload;
        }
      }else{
        lastSavedPayload=payload;
      }
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
        // hydrate() above just overwrote COMPANY with whatever /state's shared company row
        // contains -- but the platform console is never "inside" a specific client, so it must
        // never show that row's name/logo (which can carry a real tenant's branding, stale or
        // simply belonging to a different client's own upload). Force the neutral AURA identity
        // here regardless of what /state returned; entering a real client later legitimately
        // overwrites this again with that client's own branding.
        COMPANY.name='AURA';COMPANY.tagline='People Operations Cloud';COMPANY.initials='A';
        COMPANY.logo=(typeof AURA_MARK!=='undefined')?AURA_MARK:null;
        // Same reasoning as exitImpersonatedSession()'s mirror of this: the theme color is
        // stored on the same shared row as name/logo, so it needs the identical forced reset.
        COMPANY.themeKey='indigo';COMPANY.accentHex='#4f46e5';
        if(typeof window.applyTheme==='function')window.applyTheme('indigo','#4f46e5');
        if(typeof window.loadRealPlatformClients==='function')window.loadRealPlatformClients();
      }else if(payload.role==='admin'&&payload.impersonatedBy){
        // God Admin's Enter Portal, still active across a page reload. Without this branch a
        // reload here looks identical to this client's own admin logging in directly (the
        // token shape is the same) — isPlatformAdmin silently resets to false and activeClientId
        // is never set, so the "← All Clients" banner (the only way back to the client list)
        // just disappears, stranding God Admin inside the client with no visible way out.
        isPlatformAdmin=true;
        user={id:0,name:(COMPANY.name||'Company')+' Admin',email:payload.sub,role:'admin',initials:(COMPANY.initials||'A')};
        view='dashboard';
        var parkedRaw=null;
        try{parkedRaw=sessionStorage.getItem(PARKED_SESSION_KEY);}catch(e){}
        if(parkedRaw&&typeof window.loadRealPlatformClients==='function'){
          try{
            var parked=JSON.parse(parkedRaw);
            // PLATFORM_CLIENTS was just replaced by THIS tenant's own hydrated copy above —
            // borrow the parked God Admin token just long enough to re-merge the real client
            // directory back in, so activeClientId below resolves to a real, collision-checked id.
            var curToken=token,curVersion=stateVersion,curPayload=lastSavedPayload;
            token=parked.token;
            await window.loadRealPlatformClients();
            token=curToken;stateVersion=curVersion;lastSavedPayload=curPayload;
            var clientMatch=PLATFORM_CLIENTS.find(function(c){return c.tenantKey===payload.tenantKey;});
            if(clientMatch)activeClientId=clientMatch.id;
          }catch(e){}
        }
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
      // Refresh the quick-paint cache for every non-platform branch above (impersonated admin,
      // a client's own direct admin login, a matched employee) now that COMPANY reflects that
      // tenant's real hydrated branding -- see cacheBrandFor()'s own comment. Skipped for
      // role==='platform': that branch intentionally forces the neutral AURA identity instead
      // of a cacheable tenant branding, and God Admin's own tenantKey is the same one the real
      // connected company (client 1) uses, so caching AURA under it here would otherwise leak
      // into that company's own direct-admin-login quick paint.
      if(payload.role!=='platform')cacheBrandFor(token);
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
