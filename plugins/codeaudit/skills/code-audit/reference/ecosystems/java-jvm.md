# Java / JVM review reference

Load when `pom.xml`, `build.gradle(.kts)` or `*.jar` sources are present. Covers Spring (MVC, Boot, Security,
WebFlux), Jakarta/Java EE, Jackson, SnakeYAML, Hibernate/JPA, Thymeleaf/JSP/Freemarker, `ProcessBuilder`,
`ObjectInputStream`, scripting engines, and JVM XML parsers. Kotlin and Scala on the JVM use this file too.

Resolve versions from the dependency lock / resolved tree: `mvn dependency:tree`, `gradle dependencies`, or
`gradle.lockfile` — **not** from the `<version>` property, which may be overridden by a BOM or a parent POM.
See `README.md` for the version-sensitivity rule.

---

## Version facts to check

**Spring Framework — "Spring4Shell" RCE via data binding (CVE-2022-22965).** Fixed in **5.3.18** and
**5.2.20**. The original exploit requires **all** of: JDK 9+, a Spring MVC/WebFlux app, a **traditional WAR**
deployed to a servlet container (Tomcat in the advisory; Payara/GlassFish later shown affected), and a
reachable endpoint whose attacker-controlled parameters pass through Spring **data binding**.
Source: <https://spring.io/security/cve-2022-22965>
→ Spring's own advisory states the **default Spring Boot executable-JAR deployment does not satisfy the
original exploit scenario**. So: an unpatched version in a fat-JAR Boot app is a dependency-hygiene item
(`deps` class), **not** a confirmed RCE finding — say exactly that, and name the packaging evidence
(`spring-boot-maven-plugin` / `bootJar`) you used to decide. Tomcat 10.0.20 / 9.0.62 / 8.5.78 added
class-loader hardening against this path.

**SnakeYAML — arbitrary type instantiation (CVE-2022-1471). Fixed in 2.0** (Feb 2023), where `Constructor`
inherits from `SafeConstructor` and global tags are blocked by default.
Sources: <https://snyk.io/blog/snakeyaml-unsafe-deserialization-vulnerability/>,
<https://docs.herodevs.com/snakeyaml/cve-2022-1471>
→ **Spring Boot's own YAML config files are trusted input; Spring Boot is not vulnerable through them.**
Report only where the application calls the SnakeYAML API **directly on untrusted bytes** with a permissive
constructor. A 1.x version in the dependency tree with no direct API use on untrusted input is a `deps`
hygiene item, not an injection finding. On 2.x, `new Yaml(new Constructor(X.class))` is safe-by-default;
re-opening it requires an explicit permissive `LoaderOptions`/custom constructor — **that** is the finding.

**Log4j — "Log4Shell" (CVE-2021-44228) and its follow-ups.** Lookup/JNDI evaluation in logged messages.
2.15.0 was incomplete (**CVE-2021-45046**), 2.16.0/2.17.0 addressed DoS (**CVE-2021-45105**), and
**CVE-2021-44832** (JDBC Appender) landed in **2.17.1**. Treat **2.17.1+** (Java 8) as the cleared line.
Source: <https://logging.apache.org/log4j/2.x/security.html>
→ Reachability still requires attacker-controlled data reaching a logged message/parameter. In 2026 this is
almost always already remediated — confirm the resolved version before writing anything, and do not report
it on `log4j-api` alone (the vulnerable code is in `log4j-core`).

**Spring WebSocket / SockJS origin restriction — same-origin by default since 4.1.5.** Before that release
Spring did not limit which origins could open a WebSocket/SockJS connection. Browsers do **not** apply the
same-origin policy to WebSocket handshakes, so this server-side restriction is the only control.
Source: <https://docs.spring.io/spring-security/reference/servlet/integrations/websocket.html>
→ On 4.1.5+ the finding is a **permissive override** (`setAllowedOrigins("*")`, or an over-broad
`setAllowedOriginPatterns`), not an absent check. Below 4.1.5, the absence itself is the finding. Either way,
confirm a cookie-authenticated, security-relevant message handler before calling it CSWSH.

**Jackson — polymorphic deserialization.** The sink is not `ObjectMapper`; it is
`enableDefaultTyping()` / `activateDefaultTyping()` with a permissive validator, or `@JsonTypeInfo(use = Id.CLASS
| Id.MINIMAL_CLASS)` on a type reachable from untrusted JSON. Jackson 2.10+ requires a
`PolymorphicTypeValidator` with `activateDefaultTyping`; a `LaissezFaireSubTypeValidator` puts you back where
you started. The historical blocklist CVEs (gadget-by-gadget) are **not** the right frame — report the
**configuration**, which is version-independent.

---

## Framework defaults

**Spring Security.**
- `@PreAuthorize` / `@PostAuthorize` / `@Secured` are **proxy-based**: they do not fire on a `private`
  method, on a `final` class/method (CGLIB), or on a **self-invocation** (`this.method()` inside the same
  bean). A security-annotated method called internally is unguarded — this is a real, frequent authz bug.
- `SecurityFilterChain` / `HttpSecurity` rules are **ordered, first-match-wins**. `anyRequest().permitAll()`
  placed above a specific matcher changes the effective policy. `requestMatchers("/admin/**")` does not match
  `/admin` itself, and servlet-path vs request-URI mismatches have produced bypasses.
- `csrf().disable()` is the escape hatch. Correct for a stateless token API; a finding on a session-cookie app.
- Method security must be enabled (`@EnableMethodSecurity`, formerly `@EnableGlobalMethodSecurity`) —
  annotations without it are **inert**. Grep for the enabling annotation before trusting any `@PreAuthorize`.
- A `permitAll()` endpoint that nonetheless reads a principal from a **request header** (`X-User-Id`) trusts
  the client unless a proxy provably strips and replaces it.

**Templating / XSS.**
- **Thymeleaf** escapes with `th:text` and does **not** with `th:utext`. Expression evaluation in a
  user-controlled **template fragment name** or an inline `[[${...}]]` over user data is SpEL injection, which
  is RCE, not XSS.
- **JSP**: `<c:out>` escapes; `${param.x}` written directly into the page does not. `<%= %>` does not.
- **Freemarker**: escaping depends on the configured output format; `?no_esc` and a missing
  `outputFormat=HTMLOutputFormat` are the shapes.
- **SpEL / OGNL / MVEL** evaluating request data is code execution: `SpelExpressionParser().parseExpression(user)`,
  `@Value("#{...}")` over user input, and anything feeding `ExpressionParser`.

**Persistence.** JPA/Hibernate parameterize `:named` and `?1` binds. Injection lives in string-built JPQL/HQL
(`createQuery("... where x = '" + v + "'")`), `createNativeQuery` with concatenation, and — as everywhere —
**identifier slots**: `ORDER BY` / column names cannot be bound. Spring Data `@Query(nativeQuery = true)` with
SpEL `?#{...}` over user input is an injection sink. A `Sort` object built from a request parameter reaches a
column identifier.

**XML / XXE.** `DocumentBuilderFactory`, `SAXParserFactory`, `XMLInputFactory`, `TransformerFactory`,
`SchemaFactory`, `XPathFactory`, `Unmarshaller`, XMLBeans and `SAXReader` are **insecure by default** on many
JDK/parser combinations. The defense is
`setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)` or
`XMLConstants.FEATURE_SECURE_PROCESSING` plus
`setAttribute(ACCESS_EXTERNAL_DTD, "")`. Absence of those calls on a parser fed untrusted XML is the finding.

---

## Dangerous APIs

- **Command execution** — `Runtime.getRuntime().exec(String)` (the single-String overload tokenizes naively),
  `ProcessBuilder(String...)` with a shell (`sh -c`, `cmd /c`), `ProcessBuilder.command(...)` built by
  concatenation.
- **Deserialization** — `ObjectInputStream.readObject()` on untrusted bytes (sink at every version),
  `XMLDecoder.readObject()`, `XStream` without a type allowlist, Jackson default typing (above),
  Kryo/Hessian/Burlap with untrusted input, JNDI lookups (`InitialContext.lookup`, `ldap://`, `rmi://`) with
  a computed name.
- **Dynamic execution** — `ScriptEngineManager().getEngineByName("js"|"nashorn").eval(user)`, Groovy
  `GroovyShell.evaluate` / `Eval.me`, BeanShell, SpEL/OGNL/MVEL over user data, `Class.forName(user)` +
  `newInstance`.
- **Path / archive** — `new File(root, userPath)` without a canonical-path containment check
  (`getCanonicalPath().startsWith(canonicalRoot)`), `ZipInputStream`/`ZipFile` extraction without entry-name
  containment (zip-slip), `Files.newInputStream` on a computed path, `ResourceUtils.getFile`.
- **SSRF** — `HttpURLConnection`, `java.net.http.HttpClient`, `RestTemplate`, `WebClient`, OkHttp, Apache
  HttpClient with a computed URL; `URL.openStream()` accepts `file:`/`jar:`/`ftp:`.
- **Crypto** — `Cipher.getInstance("AES")` (defaults to **ECB** on most providers — specify the mode),
  `"AES/CBC/PKCS5Padding"` without a MAC (padding oracle), `new Random()`/`Math.random()` for tokens,
  `MessageDigest` MD5/SHA-1 for passwords, `String.equals` on secrets instead of
  `MessageDigest.isEqual`, and a `TrustManager` whose `checkServerTrusted` is empty.

---

## Safe or non-reportable forms

- `PreparedStatement` with `?`, JPA `setParameter`, Spring Data derived queries, `@Query` with `:named`
  binds — parameterized.
- `ProcessBuilder("bin", userArg)` with a **literal** program and no shell — not shell-parsed. **But argv is not a free pass**: the argument still reaches the program's own option parser, so a
  user-controlled value that can begin with `-`/`--` is **argument injection** (CWE-88) against a
  flag-rich binary — `git --upload-pack=`, `curl -o`, `tar --checkpoint-action=exec=`, `find -exec`,
  `ffmpeg -f lavfi`. Safe only with a literal program **and** a value that cannot start with a dash
  (validate, or pass `--` first where the program supports it).
- `th:text` / `<c:out>` / Freemarker with `HTMLOutputFormat` — escaped HTML-text slot.
- `ObjectInputStream` reading **first-party, non-attacker-writable** bytes (an internal cache file, a
  server-generated blob with an integrity check) — `design_properties` with the write-path evidence, not a
  finding. If any write path is user-reachable it **is** second-order deserialization.
- SnakeYAML 2.x with the default `Constructor` / `SafeConstructor` — safe. Only an explicit permissive
  constructor or `LoaderOptions` widening re-opens it.
- An unpatched `spring-core` in a **fat-JAR Boot** deployment — `deps` hygiene, not a confirmed Spring4Shell.
- `log4j-api` without `log4j-core` — not Log4Shell.
- MD5/SHA-1 as a cache key, ETag or content fingerprint — not a crypto finding.
- A method missing `@PreAuthorize` whose **only** callers are already behind an effective `SecurityFilterChain`
  rule or a guarded facade — resolve the call graph before claiming missing authorization.

---

## Commands

```bash
# resolved versions first (NOT the <version> property)
mvn -q dependency:tree 2>/dev/null | rg -n 'spring-core|spring-security|snakeyaml|log4j-core|jackson-databind'
rg -n 'spring-boot-maven-plugin|bootJar|<packaging>war' pom.xml build.gradle* 2>/dev/null   # packaging decides Spring4Shell

# deserialization
rg -n 'readObject\(|XMLDecoder|XStream|enableDefaultTyping|activateDefaultTyping|@JsonTypeInfo|LaissezFaire'
rg -n 'InitialContext|lookup\(|ldap://|rmi://'

# command / dynamic execution
rg -n 'Runtime\.getRuntime\(\)\.exec|ProcessBuilder|/bin/sh|cmd\.exe|cmd /c'
rg -n 'ScriptEngine|GroovyShell|Eval\.me|SpelExpressionParser|parseExpression\(|OgnlContext|Class\.forName\('

# SQL / JPQL injection incl. identifier slots
rg -n 'createQuery\(|createNativeQuery\(|@Query\(|Statement\s+\w+\s*=|executeQuery\("'
rg -n 'ORDER BY" \+|Sort\.by\(|orderBy\('

# XXE — look for the ABSENCE of these on parsers fed untrusted XML
rg -n 'DocumentBuilderFactory|SAXParserFactory|XMLInputFactory|TransformerFactory|SAXReader|Unmarshaller'
rg -n 'disallow-doctype-decl|FEATURE_SECURE_PROCESSING|ACCESS_EXTERNAL_DTD|setExpandEntityReferences'

# authz surface + proxy-bypass shapes
rg -n '@PreAuthorize|@PostAuthorize|@Secured|@RolesAllowed|@EnableMethodSecurity|@EnableGlobalMethodSecurity'
rg -n 'SecurityFilterChain|requestMatchers|antMatchers|permitAll|anyRequest|csrf\(\)' 
rg -n 'private .*@PreAuthorize|this\.\w+\(' -A1

# XSS slots
rg -n 'th:utext|<%=|\$\{param\.|\?no_esc|escapeXml="false"'

# path / archive / SSRF / crypto
rg -n 'new File\(|getCanonicalPath|ZipInputStream|ZipEntry|getNextEntry'
rg -n 'HttpURLConnection|RestTemplate|WebClient|OkHttpClient|URL\(.*\)\.openStream'
rg -n 'Cipher\.getInstance\("AES"\)|new Random\(|Math\.random|MessageDigest\.getInstance\("(MD5|SHA-1)"\)|checkServerTrusted'
```
