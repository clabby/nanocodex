// Structural fixture based on public https://www.namecheap.com/myaccount/login/
// observed 2026-10-03 at 390x740. Only public field names/layout are reproduced:
// ASP.NET POST form, hidden duplicate header controls, ID-less inputs with
// autocomplete="on" and placeholder labels, ASP.NET submit ID, footer email.
// The server, credentials, cookies and OTP page below are entirely synthetic.
// Official TOTP journey: https://www.namecheap.com/support/knowledgebase/article.aspx/10073/45/how-can-i-use-the-totp-method-for-twofactor-authentication/
// Post-password OTP DOM was NOT inspected on Namecheap. This does not test
// Namecheap authentication, anti-bot behavior, security keys or passkeys.
export const namecheapSynthetic = {username:'synthetic-namecheap-user',password:'synthetic-namecheap-password',otp:'681427'};
const submitId='ctl00_ctl00_ctl00_ctl00_base_content_web_base_content_home_content_page_content_left_ctl02_LoginButton';
const header='<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:34px;font:16px sans-serif}input:not([type=hidden]){display:block;width:100%;box-sizing:border-box;height:40px;margin:20px 0}footer{margin-top:900px}</style>';
export function createNamecheapFixture() {
  const counts={passwordPosts:0,otpPosts:0,authenticatedVisits:0};
  const handler=(req,res)=>{
    if(!req.url.startsWith('/namecheap/'))return false;
    res.setHeader('Content-Type','text/html');
    res.setHeader('Cache-Control','no-store');
    if(req.method==='POST'){
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
        const data=new URLSearchParams(body);
        if(req.url==='/namecheap/login'){
          counts.passwordPosts++;
          if(!data.getAll('LoginUserName').includes(namecheapSynthetic.username)||!data.getAll('LoginPassword').includes(namecheapSynthetic.password)){res.writeHead(403);res.end('Synthetic credentials rejected');return;}
          res.setHeader('Set-Cookie','synthetic_namecheap_pending=yes; Secure; HttpOnly; SameSite=Strict; Path=/namecheap/');
          res.writeHead(303,{Location:'/namecheap/otp'});res.end();
        }else if(req.url==='/namecheap/otp'){
          counts.otpPosts++;
          if(!req.headers.cookie?.includes('synthetic_namecheap_pending=yes')||data.get('otp')!==namecheapSynthetic.otp){res.writeHead(403);res.end('Synthetic OTP rejected');return;}
          res.setHeader('Set-Cookie','synthetic_namecheap_authenticated=yes; Secure; HttpOnly; SameSite=Strict; Path=/namecheap/');
          res.writeHead(303,{Location:'/namecheap/account'});res.end();
        }else{res.writeHead(404);res.end();}
      });return true;
    }
    if(req.url==='/namecheap/login')res.end(header+`<form method="post" id="aspnetForm" action="/namecheap/login"><input type="hidden" name="__VIEWSTATE" value="synthetic-only"><div style="display:none"><input name="LoginUserName" placeholder="Username"><input type="password" name="LoginPassword" id="gb-signin-password-input" placeholder="Password"><input type="hidden" name="hidden_LoginPassword"></div><h1>Synthetic Namecheap-shaped login</h1><input name="LoginUserName" type="text" autocomplete="on" placeholder="Username"><input name="LoginPassword" type="password" autocomplete="on" placeholder="Password"><input type="submit" id="${submitId}" name="ctl00$ctl00$ctl00$ctl00$base_content$web_base_content$home_content$page_content_left$ctl02$LoginButton" value="Sign In"><input type="hidden" name="ctl00$hidden_LoginPassword"><footer><input type="email" name="email" placeholder="you@yours.com"><button type="button">Join</button></footer></form><form id="clientForm"></form>`);
    else if(req.url==='/namecheap/otp')res.end(header+'<h1>Synthetic second-factor code</h1><form method="post" action="/namecheap/otp"><label for="otp">Verification code</label><input id="otp" name="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6"><button>Verify</button></form>');
    else if(req.url==='/namecheap/account'&&req.headers.cookie?.includes('synthetic_namecheap_authenticated=yes')){counts.authenticatedVisits++;res.end(header+'<h1>Synthetic Namecheap-shaped account verified</h1>');}
    else{res.writeHead(403);res.end('Synthetic account not authenticated');}
    return true;
  };
  return {handler,counts};
}
