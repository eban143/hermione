'use strict';

const EventEmitter = require('events').EventEmitter;
const q = require('q');
const BrowserAgent = require('gemini-core').BrowserAgent;
const RunnerEvents = require('../../../../lib/constants/runner-events');
const MochaRunner = require('../../../../lib/runner/mocha-runner');
const RetryMochaRunner = require('../../../../lib/runner/mocha-runner/retry-mocha-runner');
const TestSkipper = require('../../../../lib/runner/test-skipper');
const MochaBuilder = require('../../../../lib/runner/mocha-runner/mocha-builder');
const SuiteMonitor = require('../../../../lib/suite-monitor');
const MochaStub = require('../../_mocha');
const makeConfigStub = require('../../../utils').makeConfigStub;

describe('mocha-runner', () => {
    const sandbox = sinon.sandbox.create();

    const createMochaStub_ = () => {
        const mocha = new MochaStub();
        mocha.disableHooksInSkippedSuites = sandbox.stub();
        return mocha;
    };

    const createMochaRunner_ = () => {
        return new MochaRunner(
            'bro',
            makeConfigStub({browsers: ['bro']}),
            sinon.createStubInstance(BrowserAgent),
            sinon.createStubInstance(TestSkipper)
        );
    };

    const init_ = (suites) => createMochaRunner_().init(suites || ['test_suite']);
    const run_ = (suites) => init_(suites).run();

    beforeEach(() => {
        sandbox.stub(RetryMochaRunner.prototype, 'run');

        sandbox.stub(MochaBuilder, 'prepare');
        sandbox.stub(MochaBuilder.prototype, 'buildAdapters').returns([]);
        sandbox.stub(MochaBuilder.prototype, 'buildSingleAdapter');

        sandbox.stub(SuiteMonitor.prototype, 'suiteBegin');
        sandbox.stub(SuiteMonitor.prototype, 'suiteEnd');
        sandbox.stub(SuiteMonitor.prototype, 'testRetry');
    });

    afterEach(() => sandbox.restore());

    describe('constructor', () => {
        const testPassthroughing = (event, from) => {
            const mochaRunner = createMochaRunner_();
            const spy = sinon.spy();

            mochaRunner.on(event, spy);
            from.emit(event, 'some-data');

            assert.calledOnceWith(spy, 'some-data');
        };

        describe('mocha builder', () => {
            it('should create instance', () => {
                sandbox.spy(MochaBuilder, 'create');

                MochaRunner.create('bro', makeConfigStub({system: {foo: 'bar'}}), {browser: 'pool'}, {test: 'skipper'});

                assert.calledOnceWith(MochaBuilder.create, 'bro', {foo: 'bar'}, {browser: 'pool'}, {test: 'skipper'});
            });

            describe('should passthrough events', () => {
                const events = [
                    RunnerEvents.BEFORE_FILE_READ,
                    RunnerEvents.AFTER_FILE_READ
                ];

                events.forEach((event) => {
                    it(`${event}`, () => {
                        const mochaBuilder = new EventEmitter();
                        sandbox.stub(MochaBuilder, 'create').returns(mochaBuilder);

                        testPassthroughing(event, mochaBuilder);
                    });
                });
            });
        });

        describe('suite monitor', () => {
            it('should create an instance', () => {
                sandbox.spy(SuiteMonitor, 'create');

                createMochaRunner_();

                assert.calledOnce(SuiteMonitor.create);
            });

            describe('should passthrough events', () => {
                const events = [
                    RunnerEvents.SUITE_BEGIN,
                    RunnerEvents.SUITE_END
                ];

                events.forEach((event) => {
                    it(`${event}`, () => {
                        const suiteMonitor = new EventEmitter();
                        sandbox.stub(SuiteMonitor, 'create').returns(suiteMonitor);

                        testPassthroughing(event, suiteMonitor);
                    });
                });
            });
        });
    });

    describe('prepare', () => {
        it('should prepare mocha builder', () => {
            MochaRunner.prepare();

            assert.calledOnce(MochaBuilder.prepare);
        });
    });

    describe('init', () => {
        it('should pass files to mocha adapter builder', () => {
            init_(['some/file', 'other/file']);

            assert.calledOnceWith(MochaBuilder.prototype.buildAdapters, ['some/file', 'other/file']);
        });

        it('should return an instance of mocha runner', () => {
            const mochaRunner = createMochaRunner_();

            assert.deepEqual(mochaRunner.init(), mochaRunner);
        });

        it('should throw in case of duplicate test titles in mocha adapters in different files', () => {
            const mocha1 = createMochaStub_();
            const mocha2 = createMochaStub_();

            mocha1.updateSuiteTree((suite) => {
                return suite
                    .addTest({title: 'some test', file: 'first file'});
            });

            mocha2.updateSuiteTree((suite) => {
                return suite
                    .addTest({title: 'some test', file: 'second file'});
            });

            MochaBuilder.prototype.buildAdapters.returns([mocha1, mocha2]);

            assert.throws(() => init_(),
                'Tests with the same title \'some test\' in files \'first file\' and \'second file\' can\'t be used');
        });

        it('should throw in case of duplicate test titles in mocha adapters in the same file', () => {
            const mocha1 = createMochaStub_();
            const mocha2 = createMochaStub_();

            mocha1.updateSuiteTree((suite) => {
                return suite
                    .addTest({title: 'some test', file: 'some file'});
            });

            mocha2.updateSuiteTree((suite) => {
                return suite
                    .addTest({title: 'some test', file: 'some file'});
            });

            MochaBuilder.prototype.buildAdapters.returns([mocha1, mocha2]);

            assert.throws(() => init_(),
                'Tests with the same title \'some test\' in file \'some file\' can\'t be used');
        });

        it('should does not throw on mocha adapters without duplicates', () => {
            const mocha1 = createMochaStub_();
            const mocha2 = createMochaStub_();

            mocha1.updateSuiteTree((suite) => {
                return suite
                    .addTest({title: 'first test', file: 'first file'});
            });

            mocha2.updateSuiteTree((suite) => {
                return suite
                    .addTest({title: 'second test', file: 'second file'});
            });

            MochaBuilder.prototype.buildAdapters.returns([mocha1, mocha2]);

            assert.doesNotThrow(() => init_());
        });
    });

    describe('run', () => {
        it('should wrap each mocha instance into a retry runner', () => {
            const mocha1 = createMochaStub_();
            const mocha2 = createMochaStub_();

            MochaBuilder.prototype.buildAdapters.returns([mocha1, mocha2]);
            sandbox.spy(RetryMochaRunner, 'create');

            return run_()
                .then(() => {
                    assert.calledTwice(RetryMochaRunner.create);
                    assert.calledWith(RetryMochaRunner.create, mocha1);
                    assert.calledWith(RetryMochaRunner.create, mocha2);
                });
        });

        it('should create a retry runner for a passed browser', () => {
            MochaBuilder.prototype.buildAdapters.returns([createMochaStub_()]);
            sandbox.spy(RetryMochaRunner, 'create');

            const config = makeConfigStub({browsers: ['bro'], retry: 10});

            return MochaRunner.create('bro', config).init().run()
                .then(() => assert.calledOnceWith(RetryMochaRunner.create, sinon.match.any, config.forBrowser('bro')));
        });

        it('should run mocha instances via a retry runner', () => {
            const mocha = createMochaStub_();
            sandbox.stub(mocha, 'run');
            MochaBuilder.prototype.buildAdapters.returns([mocha]);

            return init_()
                .run({some: 'workers'})
                .then(() => {
                    assert.notCalled(mocha.run);
                    assert.calledOnceWith(RetryMochaRunner.prototype.run, {some: 'workers'});
                });
        });

        it('should wait until all mocha instances will finish their work', () => {
            const firstResolveMarker = sandbox.stub().named('First resolve marker');
            const secondResolveMarker = sandbox.stub().named('Second resolve marker');

            MochaBuilder.prototype.buildAdapters.returns([
                createMochaStub_(),
                createMochaStub_()
            ]);

            RetryMochaRunner.prototype.run
                .onFirstCall().callsFake(() => q().then(firstResolveMarker))
                .onSecondCall().callsFake(() => q.delay(1).then(secondResolveMarker));

            return run_()
                .then(() => {
                    assert.called(firstResolveMarker);
                    assert.called(secondResolveMarker);
                });
        });

        it('should be rejected if one of mocha instances rejected on run', () => {
            MochaBuilder.prototype.buildAdapters.returns([createMochaStub_()]);

            RetryMochaRunner.prototype.run.returns(q.reject('Error'));

            return assert.isRejected(run_(), /Error/);
        });

        describe('suite monitor', () => {
            it('should handle "SUITE_BEGIN" event', () => {
                const mocha = createMochaStub_();
                MochaBuilder.prototype.buildAdapters.returns([mocha]);

                RetryMochaRunner.prototype.run.callsFake(() => mocha.emit(RunnerEvents.SUITE_BEGIN, 'some-data'));

                return run_()
                    .then(() => assert.calledOnceWith(SuiteMonitor.prototype.suiteBegin, 'some-data'));
            });

            it('should handle "SUITE_END" event', () => {
                const mocha = createMochaStub_();
                MochaBuilder.prototype.buildAdapters.returns([mocha]);

                RetryMochaRunner.prototype.run.callsFake(() => mocha.emit(RunnerEvents.SUITE_END, 'some-data'));

                return run_()
                    .then(() => assert.calledOnceWith(SuiteMonitor.prototype.suiteEnd, 'some-data'));
            });

            it('should handle "RETRY" event', () => {
                const retryMochaRunner = Object.create(RetryMochaRunner.prototype);
                sandbox.stub(RetryMochaRunner, 'create').returns(retryMochaRunner);

                MochaBuilder.prototype.buildAdapters.returns([createMochaStub_()]);
                RetryMochaRunner.prototype.run.callsFake(() => retryMochaRunner.emit(RunnerEvents.RETRY, 'some-data'));

                return run_()
                    .then(() => assert.calledOnceWith(SuiteMonitor.prototype.testRetry, 'some-data'));
            });
        });

        describe('should passthrough events from a', () => {
            const testPassthroughing = (event, from) => {
                RetryMochaRunner.prototype.run.callsFake(() => from.emit(event, 'some-data'));

                const mochaRunner = createMochaRunner_();
                const spy = sinon.spy();

                mochaRunner.on(event, spy);

                return mochaRunner.init().run()
                    .then(() => assert.calledOnceWith(spy, 'some-data'));
            };

            describe('mocha runner', () => {
                const events = [
                    RunnerEvents.TEST_BEGIN,
                    RunnerEvents.TEST_END,

                    RunnerEvents.TEST_PASS,
                    RunnerEvents.TEST_PENDING,

                    RunnerEvents.INFO,
                    RunnerEvents.WARNING
                ];

                events.forEach((event) => {
                    it(`${event}`, () => {
                        const mocha = createMochaStub_();
                        MochaBuilder.prototype.buildAdapters.returns([mocha]);

                        return testPassthroughing(event, mocha);
                    });
                });
            });

            describe('retry wrapper', () => {
                const events = [
                    RunnerEvents.TEST_FAIL,
                    RunnerEvents.RETRY,
                    RunnerEvents.ERROR
                ];

                events.forEach((event) => {
                    it(`${event}`, () => {
                        const retryMochaRunner = Object.create(RetryMochaRunner.prototype);
                        sandbox.stub(RetryMochaRunner, 'create').returns(retryMochaRunner);

                        MochaBuilder.prototype.buildAdapters.returns([createMochaStub_()]);

                        return testPassthroughing(event, retryMochaRunner);
                    });
                });
            });
        });
    });

    describe('buildSuiteTree', () => {
        it('should build suite tree for specified paths', () => {
            MochaBuilder.prototype.buildSingleAdapter.returns([createMochaStub_()]);

            const mochaRunner = createMochaRunner_();
            mochaRunner.buildSuiteTree(['some/path']);

            assert.calledOnceWith(MochaBuilder.prototype.buildSingleAdapter, ['some/path']);
        });

        it('should return suite of mocha-adapter', () => {
            const mocha = createMochaStub_();
            const mochaRunner = createMochaRunner_();

            MochaBuilder.prototype.buildSingleAdapter.returns(mocha);

            assert.deepEqual(mochaRunner.buildSuiteTree(), mocha.suite);
        });

        it('should throw in case of duplicate test titles in different files', () => {
            const mocha = createMochaStub_();
            const mochaRunner = createMochaRunner_();

            mocha.updateSuiteTree((suite) => {
                return suite
                    .addTest({title: 'some test', file: 'first file'})
                    .addTest({title: 'some test', file: 'second file'});
            });

            MochaBuilder.prototype.buildSingleAdapter.returns(mocha);

            assert.throws(() => mochaRunner.buildSuiteTree(),
                'Tests with the same title \'some test\' in files \'first file\' and \'second file\' can\'t be used');
        });

        it('should throw in case of duplicate test titles in the same file', () => {
            const mocha = createMochaStub_();
            const mochaRunner = createMochaRunner_();

            mocha.updateSuiteTree((suite) => {
                return suite
                    .addTest({title: 'some test', file: 'some file'})
                    .addTest({title: 'some test', file: 'some file'});
            });

            MochaBuilder.prototype.buildSingleAdapter.returns(mocha);

            assert.throws(() => mochaRunner.buildSuiteTree(),
                'Tests with the same title \'some test\' in file \'some file\' can\'t be used');
        });

        describe('should passthrough events from a mocha runner', () => {
            const events = [
                RunnerEvents.BEFORE_FILE_READ,
                RunnerEvents.AFTER_FILE_READ
            ];

            events.forEach((event) => {
                it(`${event}`, () => {
                    MochaBuilder.prototype.buildSingleAdapter.callsFake(function() {
                        this.emit(event, 'some-data');
                        return [createMochaStub_()];
                    });

                    const mochaRunner = createMochaRunner_();
                    const spy = sinon.spy();

                    mochaRunner.on(event, spy);
                    mochaRunner.buildSuiteTree(['path/to/file']);

                    assert.calledOnceWith(spy, 'some-data');
                });
            });
        });
    });
});
